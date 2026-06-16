// End-to-end smoke tests for the C++ ncmdump core. Uses doctest via
// CMake FetchContent (no system dependency). The committed test/test.ncm
// file is the only input fixture; if it's missing the suite is skipped.

#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include <doctest/doctest.h>

#include "ncmcrypt.h"

#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <string>

namespace fs = std::filesystem;

namespace {

fs::path fixturePath() {
	if (const char *override = std::getenv("NCMDUMP_TEST_FIXTURE")) {
		return fs::path{ override };
	}
	// CMake places the test binary in <build>/test/ and the fixture is
	// resolved relative to the source dir at configure time.
#ifdef NCMDUMP_TEST_FIXTURE_DIR
	return fs::path{ NCMDUMP_TEST_FIXTURE_DIR } / "test.ncm";
#else
	return fs::path{ "test.ncm" };
#endif
}

bool hasFixture() {
	auto p = fixturePath();
	std::error_code ec;
	return fs::exists(p, ec);
}

} // namespace

TEST_CASE("opening a missing file throws") {
	CHECK_THROWS_AS(NeteaseCrypt{ "definitely-not-here-12345.ncm" }, std::exception);
}

TEST_CASE("metadata parser extracts well-known fields") {
	const char *json = R"({
        "musicName": "Test Song",
        "album": "Test Album",
        "artist": [["测试艺术家"]],
        "bitrate": 320000,
        "duration": 240,
        "format": "mp3"
    })";
	cJSON *root = cJSON_Parse(json);
	REQUIRE(root != nullptr);
	NeteaseMusicMetadata meta(root);
	CHECK(meta.name() == "Test Song");
	CHECK(meta.album() == "Test Album");
	CHECK(meta.artist() == "测试艺术家");
	CHECK(meta.bitrate() == 320000);
	CHECK(meta.duration() == 240);
	CHECK(meta.format() == "mp3");
}

TEST_CASE("metadata joins multiple artists with '/'") {
	const char *json = R"({
        "musicName": "Song",
        "album": "Album",
        "artist": [["A"], ["B"], ["C"]]
    })";
	cJSON *root = cJSON_Parse(json);
	REQUIRE(root != nullptr);
	NeteaseMusicMetadata meta(root);
	CHECK(meta.artist() == "A/B/C");
}

TEST_CASE("end-to-end dump succeeds when the fixture is present") {
	if (!hasFixture()) {
		WARN("test/test.ncm not present — skipping end-to-end test");
		return;
	}

	fs::path scratch = fs::temp_directory_path() / "ncmdump_test_out";
	fs::create_directories(scratch);

	NeteaseCrypt crypt{ fixturePath().u8string() };
	auto dumpRc = crypt.Dump(scratch.u8string());
	CHECK(dumpRc == NeteaseCrypt::ErrorCode::Ok);
	CHECK(fs::exists(crypt.dumpFilepath()));
	CHECK(crypt.dumpFilepath().extension() == ".mp3" ||
	      crypt.dumpFilepath().extension() == ".flac");

	auto fixRc = crypt.FixMetadata();
	CHECK(fixRc == NeteaseCrypt::ErrorCode::Ok);

	// Cleanup
	std::error_code ec;
	fs::remove(crypt.dumpFilepath(), ec);
	fs::remove(scratch, ec);
}