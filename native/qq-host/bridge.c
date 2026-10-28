// One QQ kernel per child process. All N-API calls are forwarded to the host's
// Node executable; this file supplies only QQ's environment lifetime query.
#include <windows.h>
#include <stddef.h>
#include <stdbool.h>

typedef void* napi_env;
typedef void* napi_value;
typedef int (*add_cleanup_fn)(napi_env, void (*)(void*), void*);

static volatile LONG stopping = 0;

__declspec(dllexport) bool qq_is_environment_stopping(void* isolate) {
  (void)isolate;
  return InterlockedCompareExchange(&stopping, 0, 0) != 0;
}
static void cleanup(void* data) {
  (void)data;
  InterlockedExchange(&stopping, 1);
}
__declspec(dllexport) napi_value napi_register_module_v1(napi_env env, napi_value exports) {
  HMODULE node = GetModuleHandleW(L"node.exe");
  if (!node) return exports;
  add_cleanup_fn add_cleanup = (add_cleanup_fn)GetProcAddress(node, "napi_add_env_cleanup_hook");
  if (!add_cleanup) return exports;
  if (add_cleanup(env, cleanup, NULL) != 0) return exports;
  return exports;
}
