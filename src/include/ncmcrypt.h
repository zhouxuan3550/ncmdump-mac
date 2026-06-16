#pragma once

#include "aes.h"
#include "cJSON.h"

#include <iostream>
#include <fstream>
#include <memory>
#include <string>

#include <filesystem>

class NeteaseMusicMetadata {

private:
	std::string mAlbum;
	std::string mArtist;
	std::string mFormat;
	std::string mName;
	int mDuration;
	int mBitrate;

private:
	cJSON* mRaw;

public:
	NeteaseMusicMetadata(cJSON*);
	~NeteaseMusicMetadata();
    const std::string& name() const { return mName; }
    const std::string& album() const { return mAlbum; }
    const std::string& artist() const { return mArtist; }
    const std::string& format() const { return mFormat; }
    int duration() const { return mDuration; }
    int bitrate() const { return mBitrate; }

};

class NeteaseCrypt {

public:
	enum class NcmFormat { MP3, FLAC };
	enum class ErrorCode {
		Ok = 0,
		ErrOpenFile = 1,
		ErrNotNcm = 2,
		ErrSeek = 3,
		ErrRead = 4,
		ErrBroken = 5,
		ErrKeyMaterial = 6,
		ErrOutputDir = 7,
		ErrOutputOpen = 8,
		ErrTagLib = 9,
		ErrUnknown = 99,
	};

	// Progress callback. `processed` and `total` are both in bytes; `total`
	// is the on-disk size of the source .ncm. `total` may be 0 if the size
	// could not be determined (e.g. file vanished between open and stat).
	// The callback is invoked at most ~20 times per second.
	typedef void (*NcmProgressCallback)(void *userdata, long long processed, long long total);

private:
	static const unsigned char sCoreKey[17];
	static const unsigned char sModifyKey[17];
	static const unsigned char mPng[8];

private:
	std::string mFilepath;
	std::filesystem::path mDumpFilepath;
	NcmFormat mFormat{ NcmFormat::MP3 };
	bool mFormatDetected{ false };
	std::string mImageData;
	std::ifstream mFile;
	unsigned char mKeyBox[256]{};
	NeteaseMusicMetadata* mMetaData{ nullptr };
	std::string mLastError;
	ErrorCode mErrorCode{ ErrorCode::Ok };

	// Progress reporting.
	long long mFileSize{ 0 };
	long long mDataProcessed{ 0 };
	NcmProgressCallback mProgressCallback{ nullptr };
	void *mProgressUserdata{ nullptr };
	std::chrono::steady_clock::time_point mLastProgressTime{};

private:
	bool isNcmFile();
	bool openFile(std::string const&);
	int read(char *s, std::streamsize n);
	void buildKeyBox(unsigned char *key, int keyLen);
	std::string mimeType(std::string& data);
	void setError(ErrorCode code, std::string message);
	void emitProgress();

public:
	const std::string& filepath() const { return mFilepath; }
	const std::filesystem::path& dumpFilepath() const { return mDumpFilepath; }
	const std::string& lastError() const { return mLastError; }
	NcmFormat format() const { return mFormat; }
	const NeteaseMusicMetadata* metadata() const { return mMetaData; }
	const std::string& imageData() const { return mImageData; }
	ErrorCode errorCode() const { return mErrorCode; }
	long long fileSize() const { return mFileSize; }

public:
	NeteaseCrypt(std::string const&);
	~NeteaseCrypt();

public:
	// `cb` is invoked periodically during Dump to report byte progress.
	// Passing `nullptr` disables progress reporting (the default).
	ErrorCode Dump(std::string const& outputDir,
	               NcmProgressCallback cb = nullptr,
	               void *userdata = nullptr);
	ErrorCode FixMetadata();
};