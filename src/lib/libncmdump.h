#pragma once

#include "ncmcrypt.h"

#ifdef _WIN32
#define API __declspec(dllexport)
#else
#define API
#endif

#ifdef __cplusplus
extern "C" {
#endif

// Library ABI version. Bump MAJOR on incompatible changes, MINOR on additions.
#define LIBNCMDUMP_VERSION_MAJOR 2
#define LIBNCMDUMP_VERSION_MINOR 0
#define LIBNCMDUMP_VERSION_PATCH 0

// Error codes mirror NeteaseCrypt::ErrorCode but stay ABI-stable as integers.
enum LibNcmError {
	LIBNCM_OK              = 0,
	LIBNCM_ERR_OPEN_FILE   = 1,
	LIBNCM_ERR_NOT_NCM     = 2,
	LIBNCM_ERR_SEEK        = 3,
	LIBNCM_ERR_READ        = 4,
	LIBNCM_ERR_BROKEN      = 5,
	LIBNCM_ERR_KEY_MATERIAL= 6,
	LIBNCM_ERR_OUTPUT_DIR  = 7,
	LIBNCM_ERR_OUTPUT_OPEN = 8,
	LIBNCM_ERR_TAGLIB      = 9,
	LIBNCM_ERR_UNKNOWN     = 99,
	LIBNCM_ERR_INVALID_ARG = 100,
};

// Lifecycle --------------------------------------------------------------------
API NeteaseCrypt* CreateNeteaseCrypt(const char* path);
API void          DestroyNeteaseCrypt(NeteaseCrypt* neteaseCrypt);

// Conversion -------------------------------------------------------------------
// Both functions return a LibNcmError code. On failure call GetLastError()
// for a human-readable message (UTF-8, never NULL).
API int Dump(NeteaseCrypt* neteaseCrypt, const char* outputPath);
API int FixMetadata(NeteaseCrypt* neteaseCrypt);

// Inspectors -------------------------------------------------------------------
// GetOutputPath returns a pointer to the dump file path buffer (UTF-8). The
// pointer is owned by the NeteaseCrypt instance and remains valid until
// DestroyNeteaseCrypt is called. NULL if no dump has been performed yet.
API const char* GetOutputPath(NeteaseCrypt* neteaseCrypt);

// GetLastError returns a UTF-8 message for the most recent failed operation
// (or empty string on success). Owned by the instance, valid until destroyed.
API const char* GetLastError(NeteaseCrypt* neteaseCrypt);

// Library version helpers.
API int GetLibVersionMajor(void);
API int GetLibVersionMinor(void);
API int GetLibVersionPatch(void);

#ifdef __cplusplus
}
#endif