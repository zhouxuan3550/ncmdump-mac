#include "libncmdump.h"

#include <filesystem>
#include <stdexcept>

namespace fs = std::filesystem;

namespace {

int mapError(NeteaseCrypt::ErrorCode code) {
	switch (code) {
		case NeteaseCrypt::ErrorCode::Ok:           return LIBNCM_OK;
		case NeteaseCrypt::ErrorCode::ErrOpenFile:  return LIBNCM_ERR_OPEN_FILE;
		case NeteaseCrypt::ErrorCode::ErrNotNcm:    return LIBNCM_ERR_NOT_NCM;
		case NeteaseCrypt::ErrorCode::ErrSeek:      return LIBNCM_ERR_SEEK;
		case NeteaseCrypt::ErrorCode::ErrRead:      return LIBNCM_ERR_READ;
		case NeteaseCrypt::ErrorCode::ErrBroken:    return LIBNCM_ERR_BROKEN;
		case NeteaseCrypt::ErrorCode::ErrKeyMaterial: return LIBNCM_ERR_KEY_MATERIAL;
		case NeteaseCrypt::ErrorCode::ErrOutputDir: return LIBNCM_ERR_OUTPUT_DIR;
		case NeteaseCrypt::ErrorCode::ErrOutputOpen:return LIBNCM_ERR_OUTPUT_OPEN;
		case NeteaseCrypt::ErrorCode::ErrTagLib:    return LIBNCM_ERR_TAGLIB;
		case NeteaseCrypt::ErrorCode::ErrUnknown:   return LIBNCM_ERR_UNKNOWN;
	}
	return LIBNCM_ERR_UNKNOWN;
}

} // namespace

extern "C" {

API NeteaseCrypt* CreateNeteaseCrypt(const char* path) {
	if (!path) {
		return nullptr;
	}
	try {
		fs::path fPath = fs::u8path(path);
		return new NeteaseCrypt(fPath.u8string());
	} catch (const std::exception &) {
		return nullptr;
	} catch (...) {
		return nullptr;
	}
}

API void DestroyNeteaseCrypt(NeteaseCrypt* neteaseCrypt) {
	delete neteaseCrypt;
}

API int Dump(NeteaseCrypt* neteaseCrypt, const char* outputPath) {
	if (!neteaseCrypt) {
		return LIBNCM_ERR_INVALID_ARG;
	}
	try {
		return mapError(neteaseCrypt->Dump(outputPath ? outputPath : ""));
	} catch (...) {
		return LIBNCM_ERR_UNKNOWN;
	}
}

API int FixMetadata(NeteaseCrypt* neteaseCrypt) {
	if (!neteaseCrypt) {
		return LIBNCM_ERR_INVALID_ARG;
	}
	try {
		return mapError(neteaseCrypt->FixMetadata());
	} catch (...) {
		return LIBNCM_ERR_UNKNOWN;
	}
}

API const char* GetOutputPath(NeteaseCrypt* neteaseCrypt) {
	if (!neteaseCrypt) {
		return nullptr;
	}
	return neteaseCrypt->dumpFilepath().u8string().c_str();
}

API const char* GetLastError(NeteaseCrypt* neteaseCrypt) {
	if (!neteaseCrypt) {
		return nullptr;
	}
	return neteaseCrypt->lastError().c_str();
}

API int GetLibVersionMajor(void) { return LIBNCMDUMP_VERSION_MAJOR; }
API int GetLibVersionMinor(void) { return LIBNCMDUMP_VERSION_MINOR; }
API int GetLibVersionPatch(void) { return LIBNCMDUMP_VERSION_PATCH; }

} // extern "C"