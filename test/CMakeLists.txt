# C++ unit + smoke tests for ncmdump. Built only when BUILD_TESTING is ON.
# Pulls in doctest via FetchContent so no system package is required.

include(FetchContent)

FetchContent_Declare(
	doctest
	GIT_REPOSITORY https://github.com/doctest/doctest.git
	GIT_TAG v2.4.11
	GIT_SHALLOW TRUE
)
FetchContent_MakeAvailable(doctest)

set(TEST_SOURCES
	${CMAKE_CURRENT_SOURCE_DIR}/ncmcrypt_test.cpp
	${COMMON_SOURCES}
)

add_executable(ncmdump_tests ${TEST_SOURCES})
target_include_directories(ncmdump_tests PRIVATE ${CMAKE_SOURCE_DIR}/src/include)
target_compile_definitions(ncmdump_tests PRIVATE
	NCMDUMP_TEST_FIXTURE_DIR="${CMAKE_CURRENT_SOURCE_DIR}")
target_link_libraries(ncmdump_tests PRIVATE TagLib::tag doctest::doctest)
set_target_properties(ncmdump_tests PROPERTIES OUTPUT_NAME "ncmdump_tests")

enable_testing()
add_test(NAME ncmdump_tests COMMAND ncmdump_tests)