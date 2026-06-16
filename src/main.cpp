#include "ncmcrypt.h"

#include <atomic>
#include <condition_variable>
#include <iostream>
#include <mutex>
#include <queue>
#include <sstream>
#include <stdexcept>
#include <thread>
#include <vector>
#include <filesystem>

#if defined(_WIN32)
#include "platform.h"
#endif

#include "color.h"
#include "version.h"
#include "cxxopts.hpp"

namespace fs = std::filesystem;

namespace {

enum class LogLevel { Quiet, Normal, Verbose };

struct CliOptions {
	std::vector<std::string> files;
	std::string directory;
	bool recursive{ false };
	std::string output;
	bool remove{ false };
	int jobs{ 1 };
	LogLevel log{ LogLevel::Normal };
	bool jsonMode{ false };
	bool dryRun{ false };
};

void emitJson(const std::string &type, const std::string &payload) {
	std::cout << "{\"type\":\"" << type << "\",\"payload\":" << payload << "}\n";
	std::cout.flush();
}

std::string quoteJson(const std::string &value) {
	std::string out;
	out.reserve(value.size() + 2);
	out.push_back('"');
	for (char c : value) {
		switch (c) {
		case '"':  out += "\\\""; break;
		case '\\': out += "\\\\"; break;
		case '\n': out += "\\n";  break;
		case '\r': out += "\\r";  break;
		case '\t': out += "\\t";  break;
		default:
			if (static_cast<unsigned char>(c) < 0x20) {
				char buf[8];
				std::snprintf(buf, sizeof(buf), "\\u%04x", c);
				out += buf;
			} else {
				out.push_back(c);
			}
		}
	}
	out.push_back('"');
	return out;
}

void logInfo(const CliOptions &opts, const std::string &msg) {
	if (opts.log == LogLevel::Quiet) return;
	if (opts.jsonMode) {
		emitJson("info", quoteJson(msg));
	} else {
		std::cout << msg << std::endl;
	}
}

void logWarn(const CliOptions &opts, const std::string &msg) {
	if (opts.jsonMode) {
		emitJson("warn", quoteJson(msg));
	} else {
		std::cout << BOLDYELLOW << "[Warn] " << RESET << msg << std::endl;
	}
}

void logError(const CliOptions &opts, const std::string &msg) {
	if (opts.jsonMode) {
		emitJson("error", quoteJson(msg));
	} else {
		std::cerr << BOLDRED << "[Error] " << RESET << msg << std::endl;
	}
}

void logDone(const CliOptions &opts, const std::string &src, const std::string &out, bool removed) {
	if (opts.jsonMode) {
		std::ostringstream p;
		p << "{\"source\":" << quoteJson(src)
		  << ",\"output\":" << quoteJson(out)
		  << ",\"removed\":" << (removed ? "true" : "false") << "}";
		emitJson("done", p.str());
	} else {
		std::cout << BOLDGREEN << "[Done] " << RESET << "'" << src << "' -> '" << out << "'";
		if (removed) std::cout << " with removed as required.";
		std::cout << std::endl;
	}
}

// Build a Dump progress callback that emits a `progress` JSON line. The
// caller passes a `std::string*` (its address) as userdata and must keep
// that string alive for the duration of Dump. The leading `+` is a C++11
// trick that forces conversion of a stateless lambda to a function pointer.
NeteaseCrypt::NcmProgressCallback makeProgressCallback() {
	return +[](void *ud, long long processed, long long total) {
		auto *src = static_cast<std::string *>(ud);
		std::ostringstream p;
		p << "{\"source\":" << quoteJson(*src)
		  << ",\"processed\":" << processed
		  << ",\"total\":" << total << "}";
		emitJson("progress", p.str());
	};
}

struct ProcessOutcome {
	bool ok{ false };
	std::string outputPath;
	std::string message;
};

ProcessOutcome processFile(const fs::path &filePath, const fs::path &outputFolder, bool removeOriginal, const CliOptions &opts) {
	ProcessOutcome outcome;
	if (fs::exists(filePath) == false) {
		outcome.message = "file '" + filePath.u8string() + "' does not exist.";
		logError(opts, outcome.message);
		return outcome;
	}

	if (!filePath.has_extension() || filePath.extension().u8string() != ".ncm") {
		outcome.ok = true; // skipping is not an error
		outcome.message = "skipped (not .ncm): " + filePath.u8string();
		return outcome;
	}

	try {
		NeteaseCrypt crypt(filePath.u8string());
		if (opts.dryRun) {
			outcome.ok = true;
			outcome.outputPath = (outputFolder.empty()
				? filePath
				: outputFolder / filePath.filename()).u8string();
			outcome.message = "dry-run: would convert " + filePath.u8string();
			logInfo(opts, outcome.message);
			return outcome;
		}

		// Only install a progress callback when the consumer can read it.
		// Human-readable mode prints to a TTY that doesn't speak JSON Lines.
		const std::string sourceStr = filePath.u8string();
		NeteaseCrypt::NcmProgressCallback cb = nullptr;
		void *cbUd = nullptr;
		if (opts.jsonMode) {
			cb = makeProgressCallback();
			cbUd = const_cast<std::string *>(&sourceStr);
		}

		auto dumpResult = crypt.Dump(outputFolder.u8string(), cb, cbUd);
		if (dumpResult != NeteaseCrypt::ErrorCode::Ok) {
			outcome.message = crypt.lastError();
			logError(opts, outcome.message);
			return outcome;
		}

		auto fixResult = crypt.FixMetadata();
		if (fixResult != NeteaseCrypt::ErrorCode::Ok) {
			outcome.message = crypt.lastError();
			logError(opts, outcome.message);
			return outcome;
		}

		outcome.ok = true;
		outcome.outputPath = crypt.dumpFilepath().u8string();

		if (removeOriginal) {
			std::error_code ec;
			fs::remove(filePath, ec);
			if (ec) {
				logWarn(opts, "failed to remove source '" + filePath.u8string() +
				              "': " + ec.message());
			}
		}

		logDone(opts, filePath.u8string(), outcome.outputPath, removeOriginal);
		return outcome;
	}
	catch (const std::exception &e) {
		outcome.message = std::string(e.what()) + " '" + filePath.u8string() + "'";
		logError(opts, outcome.message);
		return outcome;
	}
	catch (...) {
		outcome.message = "Unexpected exception while processing file: " + filePath.u8string();
		logError(opts, outcome.message);
		return outcome;
	}
}

// Bounded-parallel queue. Workers pull paths, process them, push results.
class WorkerPool {
public:
	WorkerPool(int n) {
		if (n < 1) n = 1;
		workers_.reserve(static_cast<size_t>(n));
		for (int i = 0; i < n; ++i) {
			workers_.emplace_back([this] { loop(); });
		}
	}
	~WorkerPool() {
		{
			std::lock_guard<std::mutex> lk(m_);
			stop_ = true;
		}
		cv_.notify_all();
		for (auto &t : workers_) {
			if (t.joinable()) t.join();
		}
	}

	void submit(fs::path path, fs::path outputFolder, bool removeOriginal, const CliOptions *opts) {
		{
			std::lock_guard<std::mutex> lk(m_);
			queue_.push({std::move(path), std::move(outputFolder), removeOriginal, opts});
		}
		cv_.notify_one();
	}

	std::vector<ProcessOutcome> drain() {
		std::lock_guard<std::mutex> lk(m_);
		return std::move(done_);
	}

private:
	struct Job {
		fs::path path;
		fs::path outputFolder;
		bool removeOriginal;
		const CliOptions *opts;
	};

	void loop() {
		while (true) {
			Job job;
			{
				std::unique_lock<std::mutex> lk(m_);
				cv_.wait(lk, [this] { return stop_ || !queue_.empty(); });
				if (stop_ && queue_.empty()) return;
				job = std::move(queue_.front());
				queue_.pop();
			}
			auto outcome = processFile(job.path, job.outputFolder, job.removeOriginal, *job.opts);
			std::lock_guard<std::mutex> lk(m_);
			done_.push_back(std::move(outcome));
		}
	}

	std::vector<std::thread> workers_;
	std::queue<Job> queue_;
	std::vector<ProcessOutcome> done_;
	std::mutex m_;
	std::condition_variable cv_;
	bool stop_{ false };
};

} // namespace

int main(int argc, char **argv)
{
#if defined(_WIN32)
	win32_utf8argv(&argc, &argv); // Convert command line arguments to UTF-8 under Windows
#endif

	cxxopts::Options options("ncmdump");

	options.add_options()
		("h,help", "Print usage")
		("d,directory", "Process files in a folder (requires folder path)", cxxopts::value<std::string>())
		("r,recursive", "Process files recursively (requires -d option)")
		("o,output", "Output folder (default: original file folder)", cxxopts::value<std::string>())
		("v,version", "Print version information")
		("m,remove", "Remove original file if done")
		("j,jobs", "Number of parallel workers (default: 1)", cxxopts::value<int>()->default_value("1"))
		("q,quiet", "Suppress non-error output")
		("json", "Emit one JSON object per line for programmatic consumption")
		("dry-run", "Walk inputs and report what would be done, without writing files")
		("filenames", "Input files", cxxopts::value<std::vector<std::string>>());

	options.positional_help("<files>");
	options.parse_positional({"filenames"});
	options.allow_unrecognised_options();

	cxxopts::ParseResult result;
	try {
		result = options.parse(argc, argv);
	} catch (const cxxopts::exceptions::parsing &e) {
		std::cout << options.help() << std::endl;
		return 1;
	}

	if (result.unmatched().size() > 0) {
		std::cerr << BOLDRED << "[Error] " << RESET
		          << "unrecognized arguments:";
		for (const auto &u : result.unmatched()) std::cerr << " '" << u << "'";
		std::cerr << std::endl;
		std::cout << options.help() << std::endl;
		return 2;
	}

	if (result.count("help")) {
		std::cout << options.help() << std::endl;
		return 0;
	}

	if (result.count("version")) {
		std::cout << "ncmdump version " << VERSION_MAJOR << "." << VERSION_MINOR << "." << VERSION_PATCH << std::endl;
		return 0;
	}

	CliOptions cli;
	cli.recursive = result.count("recursive") > 0;
	cli.remove = result.count("remove") > 0;
	cli.jobs = std::max(1, result["jobs"].as<int>());
	cli.log = result.count("quiet") > 0 ? LogLevel::Quiet : LogLevel::Normal;
	cli.jsonMode = result.count("json") > 0;
	cli.dryRun = result.count("dry-run") > 0;

	if (result.count("output")) {
		cli.output = result["output"].as<std::string>();
	}
	if (result.count("directory")) {
		cli.directory = result["directory"].as<std::string>();
	}
	if (result.count("filenames")) {
		cli.files = result["filenames"].as<std::vector<std::string>>();
	}

	if (cli.directory.empty() && cli.files.empty()) {
		std::cout << options.help() << std::endl;
		return 1;
	}

	if (cli.recursive && cli.directory.empty()) {
		logError(cli, "-r/--recursive requires -d/--directory.");
		return 1;
	}

	fs::path outputDir;
	bool outputDirSpecified = !cli.output.empty();
	if (outputDirSpecified) {
		outputDir = fs::u8path(cli.output);
		if (fs::exists(outputDir) && !fs::is_directory(outputDir)) {
			logError(cli, "'" + outputDir.u8string() + "' is not a valid directory.");
			return 1;
		}
		std::error_code ec;
		fs::create_directories(outputDir, ec);
		if (ec) {
			logError(cli, "failed to create output directory '" + outputDir.u8string() + "': " + ec.message());
			return 1;
		}
	}

	WorkerPool pool(cli.jobs);

	if (!cli.directory.empty()) {
		fs::path sourceDir = fs::u8path(cli.directory);
		if (!fs::is_directory(sourceDir)) {
			logError(cli, "'" + sourceDir.u8string() + "' is not a valid directory.");
			return 1;
		}

		if (cli.recursive) {
			for (const auto &entry : fs::recursive_directory_iterator(sourceDir)) {
				if (!entry.is_regular_file()) continue;
				const auto &path = fs::u8path(entry.path().u8string());
				const auto relativePath = fs::relative(path, sourceDir);
				fs::path destination = outputDirSpecified
					? outputDir / relativePath
					: sourceDir / relativePath;
				if (outputDirSpecified) {
					std::error_code ec;
					fs::create_directories(destination.parent_path(), ec);
				}
				pool.submit(path, destination.parent_path(), cli.remove, &cli);
			}
		} else {
			for (const auto &entry : fs::directory_iterator(sourceDir)) {
				if (!entry.is_regular_file()) continue;
				const auto &path = fs::u8path(entry.path().u8string());
				fs::path outFolder = outputDirSpecified ? outputDir : fs::path();
				pool.submit(path, outFolder, cli.remove, &cli);
			}
		}
	} else {
		for (const auto &filePath : cli.files) {
			fs::path filePathU8 = fs::u8path(filePath);
			if (!fs::is_regular_file(filePathU8)) {
				logError(cli, "'" + filePathU8.u8string() + "' is not a valid file.");
				continue;
			}
			pool.submit(filePathU8, outputDir, cli.remove, &cli);
		}
	}

	pool.drain(); // pool destructor joins workers
	return 0;
}