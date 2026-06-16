#include "ncmcrypt.h"
#include "aes.h"
#include "base64.h"
#include "cJSON.h"
#include "color.h"

#include <taglib/tfile.h>
#include <taglib/mpegfile.h>
#include <taglib/flacfile.h>
#include <taglib/attachedpictureframe.h>
#include <taglib/id3v2tag.h>
#include <taglib/tag.h>

#include <chrono>
#include <stdexcept>
#include <string>
#include <filesystem>

#include <cstdint>
#include <cstring>

#ifdef _MSC_VER
#pragma warning(push)
#pragma warning(disable:4267)
#pragma warning(disable:4244)
#endif

const unsigned char NeteaseCrypt::sCoreKey[17] = {0x68, 0x7A, 0x48, 0x52, 0x41, 0x6D, 0x73, 0x6F, 0x35, 0x6B, 0x49, 0x6E, 0x62, 0x61, 0x78, 0x57, 0};
const unsigned char NeteaseCrypt::sModifyKey[17] = {0x23, 0x31, 0x34, 0x6C, 0x6A, 0x6B, 0x5F, 0x21, 0x5C, 0x5D, 0x26, 0x30, 0x55, 0x3C, 0x27, 0x28, 0};

const unsigned char NeteaseCrypt::mPng[8] = {0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A};

static void aesEcbDecrypt(const unsigned char *key, const std::string &src, std::string &dst)
{
	dst.clear();
	if (src.empty()) {
		return;
	}

	const size_t totalBlocks = src.size() >> 4;
	if (totalBlocks == 0) {
		return;
	}

	dst.reserve(totalBlocks * 16);

	AES aes(key);
	unsigned char out[16];

	// All but the last block: PKCS#7 padding bytes are guaranteed to be in the last block.
	for (size_t i = 0; i + 1 < totalBlocks; ++i) {
		aes.decrypt(reinterpret_cast<unsigned char *>(const_cast<char *>(src.data())) + (i << 4), out);
		dst.append(reinterpret_cast<const char *>(out), 16);
	}

	aes.decrypt(reinterpret_cast<unsigned char *>(const_cast<char *>(src.data())) + ((totalBlocks - 1) << 4), out);
	unsigned char pad = out[15];
	if (pad == 0 || pad > 16) {
		// Bad padding — fall back to writing the full last block to avoid losing data,
		// but stop at 16 bytes so we never overrun.
		dst.append(reinterpret_cast<const char *>(out), 16);
		return;
	}
	dst.append(reinterpret_cast<const char *>(out), 16 - pad);
}

NeteaseMusicMetadata::~NeteaseMusicMetadata()
{
	cJSON_Delete(mRaw);
}

NeteaseMusicMetadata::NeteaseMusicMetadata(cJSON *raw)
{
	if (!raw)
	{
		return;
	}

	cJSON *swap;
	int artistLen, i;

	mRaw = raw;

	swap = cJSON_GetObjectItem(raw, "musicName");
	if (swap)
	{
		mName = std::string(cJSON_GetStringValue(swap));
	}

	swap = cJSON_GetObjectItem(raw, "album");
	if (swap)
	{
		mAlbum = std::string(cJSON_GetStringValue(swap));
	}

	swap = cJSON_GetObjectItem(raw, "artist");
	if (swap)
	{
		artistLen = cJSON_GetArraySize(swap);

		i = 0;
		for (i = 0; i < artistLen; i++)
		{
			auto artist = cJSON_GetArrayItem(swap, i);
			if (cJSON_GetArraySize(artist) > 0)
			{
				if (!mArtist.empty())
				{
					mArtist += "/";
				}
				mArtist += std::string(cJSON_GetStringValue(cJSON_GetArrayItem(artist, 0)));
			}
		}
	}

	swap = cJSON_GetObjectItem(raw, "bitrate");
	if (swap)
	{
		mBitrate = swap->valueint;
	}

	swap = cJSON_GetObjectItem(raw, "duration");
	if (swap)
	{
		mDuration = swap->valueint;
	}

	swap = cJSON_GetObjectItem(raw, "format");
	if (swap)
	{
		mFormat = std::string(cJSON_GetStringValue(swap));
	}
}

bool NeteaseCrypt::openFile(std::string const &path)
{
	mFile.open(std::filesystem::u8path(path), std::ios::in | std::ios::binary);
	return mFile.is_open();
}

bool NeteaseCrypt::isNcmFile()
{
	unsigned int header;

	mFile.read(reinterpret_cast<char *>(&header), sizeof(header));
	if (header != static_cast<unsigned int>(0x4e455443))
	{
		return false;
	}

	mFile.read(reinterpret_cast<char *>(&header), sizeof(header));
	if (header != static_cast<unsigned int>(0x4d414446))
	{
		return false;
	}

	return true;
}

int NeteaseCrypt::read(char *s, std::streamsize n)
{
	if (!mFile) {
		throw std::runtime_error("Can't read file: stream not in a readable state");
	}
	mFile.read(s, n);
	const std::streamsize gcount = mFile.gcount();

	if (gcount <= 0)
	{
		throw std::runtime_error("Can't read file: end of stream or read error");
	}

	return static_cast<int>(gcount);
}

void NeteaseCrypt::buildKeyBox(unsigned char *key, int keyLen)
{
	if (keyLen <= 0) {
		throw std::invalid_argument("buildKeyBox: keyLen must be positive");
	}

	for (int i = 0; i < 256; ++i)
	{
		mKeyBox[i] = static_cast<unsigned char>(i);
	}

	unsigned char swap = 0;
	unsigned char c = 0;
	unsigned char last_byte = 0;
	int key_offset = 0;

	for (int i = 0; i < 256; ++i)
	{
		swap = mKeyBox[i];
		c = static_cast<unsigned char>((swap + last_byte + key[key_offset]) & 0xff);
		if (++key_offset >= keyLen)
			key_offset = 0;
		mKeyBox[i] = mKeyBox[c];
		mKeyBox[c] = swap;
		last_byte = c;
	}
}

std::string NeteaseCrypt::mimeType(std::string &data)
{
	if (data.size() >= 8 && memcmp(data.c_str(), mPng, 8) == 0)
	{
		return std::string("image/png");
	}

	return std::string("image/jpeg");
}

void NeteaseCrypt::setError(ErrorCode code, std::string message)
{
	mLastError = std::move(message);
	mErrorCode = code;
}

void NeteaseCrypt::emitProgress()
{
	if (!mProgressCallback) {
		return;
	}
	// Throttle to ~20 Hz so a busy stream doesn't drown the consumer (the
	// JSON line per event is line-buffered on the sidecar side).
	constexpr long long kMinIntervalMs = 50;
	const auto now = std::chrono::steady_clock::now();
	const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
		now - mLastProgressTime).count();
	if (mLastProgressTime.time_since_epoch().count() != 0 && elapsed < kMinIntervalMs) {
		return;
	}
	mLastProgressTime = now;
	mProgressCallback(mProgressUserdata, mDataProcessed, mFileSize);
}

NeteaseCrypt::ErrorCode NeteaseCrypt::FixMetadata()
{
	if (mDumpFilepath.empty()) {
		setError(ErrorCode::ErrBroken, "Dump has not been performed yet");
		return mErrorCode;
	}

	try {
		// Detect format from the dumped extension if format wasn't set during Dump().
		if (!mFormatDetected) {
			auto ext = mDumpFilepath.extension().u8string();
			if (ext == u8".mp3") {
				mFormat = NcmFormat::MP3;
			} else if (ext == u8".flac") {
				mFormat = NcmFormat::FLAC;
			} else {
				setError(ErrorCode::ErrBroken, "Unknown audio format for metadata fix");
				return mErrorCode;
			}
		}

		const std::string dumpPath = mDumpFilepath.u8string();
		TagLib::ByteVector vector(mImageData.c_str(), static_cast<unsigned int>(mImageData.length()));

		if (mFormat == NcmFormat::MP3) {
			TagLib::MPEG::File audioFile(dumpPath.c_str());
			TagLib::ID3v2::Tag *tag = audioFile.ID3v2Tag(true);
			if (!tag) {
				setError(ErrorCode::ErrTagLib, "Failed to create ID3v2 tag");
				return mErrorCode;
			}

			if (!mImageData.empty()) {
				auto *frame = new TagLib::ID3v2::AttachedPictureFrame;
				frame->setMimeType(mimeType(mImageData));
				frame->setPicture(vector);
				tag->addFrame(frame);
			}

			if (mMetaData != nullptr) {
				tag->setTitle(TagLib::String(mMetaData->name(), TagLib::String::UTF8));
				tag->setArtist(TagLib::String(mMetaData->artist(), TagLib::String::UTF8));
				tag->setAlbum(TagLib::String(mMetaData->album(), TagLib::String::UTF8));
			}

			if (!audioFile.save()) {
				setError(ErrorCode::ErrTagLib, "Failed to save MP3 file with metadata");
				return mErrorCode;
			}
		} else {
			TagLib::FLAC::File audioFile(dumpPath.c_str());
			TagLib::Tag *tag = audioFile.tag();
			if (!tag) {
				setError(ErrorCode::ErrTagLib, "Failed to access FLAC tag");
				return mErrorCode;
			}

			if (!mImageData.empty()) {
				auto *cover = new TagLib::FLAC::Picture;
				cover->setMimeType(mimeType(mImageData));
				cover->setType(TagLib::FLAC::Picture::FrontCover);
				cover->setData(vector);
				audioFile.addPicture(cover);
			}

			if (mMetaData != nullptr) {
				tag->setTitle(TagLib::String(mMetaData->name(), TagLib::String::UTF8));
				tag->setArtist(TagLib::String(mMetaData->artist(), TagLib::String::UTF8));
				tag->setAlbum(TagLib::String(mMetaData->album(), TagLib::String::UTF8));
			}

			if (!audioFile.save()) {
				setError(ErrorCode::ErrTagLib, "Failed to save FLAC file with metadata");
				return mErrorCode;
			}
		}

		setError(ErrorCode::Ok, "");
		return ErrorCode::Ok;
	} catch (const std::exception &e) {
		setError(ErrorCode::ErrTagLib, std::string("TagLib exception: ") + e.what());
		return mErrorCode;
	} catch (...) {
		setError(ErrorCode::ErrUnknown, "Unknown exception during FixMetadata");
		return mErrorCode;
	}
}

NeteaseCrypt::ErrorCode NeteaseCrypt::Dump(std::string const &outputDir,
                                          NcmProgressCallback cb,
                                          void *userdata)
{
	mProgressCallback = cb;
	mProgressUserdata = userdata;
	mDataProcessed = 0;
	mLastProgressTime = {};

	try {
		if (outputDir.empty()) {
			mDumpFilepath = std::filesystem::u8path(mFilepath);
		} else {
			std::error_code ec;
			std::filesystem::create_directories(std::filesystem::u8path(outputDir), ec);
			if (ec) {
				setError(ErrorCode::ErrOutputDir,
				         "Failed to create output directory '" + outputDir + "': " + ec.message());
				return mErrorCode;
			}
			mDumpFilepath = std::filesystem::u8path(outputDir) /
				std::filesystem::u8path(mFilepath).filename();
		}

		std::vector<unsigned char> buffer(0x8000);
		std::ofstream output;

		while (mFile) {
			const int n = read(reinterpret_cast<char *>(buffer.data()),
			                   static_cast<std::streamsize>(buffer.size()));

			// Stream cipher XOR — unrolled for higher throughput.
			for (int i = 0; i < n; ++i) {
				const int j = (i + 1) & 0xff;
				buffer[i] ^= mKeyBox[(mKeyBox[j] + mKeyBox[(mKeyBox[j] + j) & 0xff]) & 0xff];
			}

			if (!output.is_open()) {
				// Identify format from the first 3 bytes (ID3 header for MP3, "fLaC" for FLAC).
				if (n >= 3 && buffer[0] == 0x49 && buffer[1] == 0x44 && buffer[2] == 0x33) {
					mDumpFilepath.replace_extension("mp3");
					mFormat = NcmFormat::MP3;
				} else {
					mDumpFilepath.replace_extension("flac");
					mFormat = NcmFormat::FLAC;
				}
				mFormatDetected = true;

				output.open(mDumpFilepath, std::ofstream::out | std::ofstream::binary);
				if (!output.is_open()) {
					setError(ErrorCode::ErrOutputOpen,
					         "Failed to open output file for writing: " + mDumpFilepath.u8string());
					return mErrorCode;
				}
			}

			output.write(reinterpret_cast<char *>(buffer.data()), n);
			if (!output) {
				setError(ErrorCode::ErrOutputOpen,
				         "Failed to write to output file: " + mDumpFilepath.u8string());
				return mErrorCode;
			}

			mDataProcessed += n;
			emitProgress();
		}

		output.flush();
		output.close();

		// Final 100% tick so the consumer can show a complete bar.
		if (mFileSize <= 0) {
			mFileSize = mDataProcessed;
		}
		mDataProcessed = mFileSize;
		emitProgress();

		setError(ErrorCode::Ok, "");
		return ErrorCode::Ok;
	} catch (const std::exception &e) {
		setError(ErrorCode::ErrUnknown, std::string("Dump failed: ") + e.what());
		return mErrorCode;
	} catch (...) {
		setError(ErrorCode::ErrUnknown, "Unknown exception during Dump");
		return mErrorCode;
	}
}

NeteaseCrypt::~NeteaseCrypt()
{
	if (mMetaData != NULL)
	{
		delete mMetaData;
	}

	if (mFile.is_open()) {
		mFile.close();
	}
}

NeteaseCrypt::NeteaseCrypt(std::string const &path)
{
	// Total size of the source .ncm for progress reporting. Best-effort: if
	// stat fails (race, sandbox, ...) leave it at 0 and the consumer just
	// won't show a percentage.
	std::error_code ec;
	mFileSize = static_cast<long long>(
		std::filesystem::file_size(std::filesystem::u8path(path), ec));
	if (ec) {
		mFileSize = 0;
	}

	if (!openFile(path))
	{
		setError(ErrorCode::ErrOpenFile, "Can't open file: " + path);
		throw std::runtime_error(mLastError);
	}

	if (!isNcmFile())
	{
		setError(ErrorCode::ErrNotNcm, "Not a netease protected file: " + path);
		throw std::runtime_error(mLastError);
	}

	// Skip 2 bytes gap between magic and key length (the gap is part of the file format).
	if (!mFile.seekg(2, mFile.cur))
	{
		setError(ErrorCode::ErrSeek, "Can't seek file: " + path);
		throw std::runtime_error(mLastError);
	}

	mFilepath = path;

	unsigned int n = 0;
	read(reinterpret_cast<char *>(&n), sizeof(n));

	if (n <= 0)
	{
		setError(ErrorCode::ErrBroken, "Broken NCM file: " + path);
		throw std::runtime_error(mLastError);
	}

	std::vector<char> keydata(n);
	read(keydata.data(), n);

	for (size_t i = 0; i < n; i++)
	{
		keydata[i] ^= 0x64;
	}

	std::string rawKeyData(keydata.begin(), keydata.end());
	std::string mKeyData;

	aesEcbDecrypt(sCoreKey, rawKeyData, mKeyData);

	if (mKeyData.length() <= 17) {
		setError(ErrorCode::ErrKeyMaterial, "Decrypted key material too short: " + path);
		throw std::runtime_error(mLastError);
	}
	buildKeyBox(reinterpret_cast<unsigned char *>(mKeyData.data()) + 17,
	            static_cast<int>(mKeyData.length()) - 17);

	read(reinterpret_cast<char *>(&n), sizeof(n));

	if (n <= 0)
	{
		std::cout << BOLDYELLOW << "[Warn] " << RESET << "'" << path
		          << "' missing metadata; some info cannot be restored." << std::endl;

		mMetaData = NULL;
	}
	else
	{
		std::vector<char> modifyData(n);
		read(modifyData.data(), n);

		for (size_t i = 0; i < n; i++)
		{
			modifyData[i] ^= 0x63;
		}

		std::string swapModifyData;
		std::string modifyOutData;
		std::string modifyDecryptData;

		swapModifyData = std::string(modifyData.begin() + 22, modifyData.end());

		// Strip the "163 key(Don't modify):" prefix before base64 decoding.
		Base64::Decode(swapModifyData, modifyOutData);

		aesEcbDecrypt(sModifyKey, modifyOutData, modifyDecryptData);

		// Strip the "music:" prefix.
		if (modifyDecryptData.size() > 6) {
			modifyDecryptData = std::string(modifyDecryptData.begin() + 6, modifyDecryptData.end());
		}

		mMetaData = new NeteaseMusicMetadata(cJSON_Parse(modifyDecryptData.c_str()));
	}

	// Skip 5 bytes (CRC32 + image version).
	if (!mFile.seekg(5, mFile.cur))
	{
		setError(ErrorCode::ErrSeek, "Can't seek past CRC32/image version: " + path);
		throw std::runtime_error(mLastError);
	}

	std::uint32_t cover_frame_len = 0;
	read(reinterpret_cast<char *>(&cover_frame_len), 4);
	read(reinterpret_cast<char *>(&n), sizeof(n));

	if (n > 0)
	{
		mImageData.assign(static_cast<size_t>(n), '\0');
		read(&mImageData[0], static_cast<std::streamsize>(n));
	}
	else
	{
		std::cout << BOLDYELLOW << "[Warn] " << RESET << "'" << path
		          << "' missing album art; cover will not be embedded." << std::endl;
	}
	mFile.seekg(static_cast<std::streamoff>(cover_frame_len) - static_cast<std::streamoff>(n),
	            mFile.cur);
}

#ifdef _MSC_VER
#pragma warning(pop)
#endif