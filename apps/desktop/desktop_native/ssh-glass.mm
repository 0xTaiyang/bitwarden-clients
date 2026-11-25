#import <AppKit/AppKit.h>
#include <node_api.h>
#include <cstring>

// Electron exposes an NSView pointer, not an NSWindow pointer, on macOS.
// This bridge is main-process-only and stores no native objects beyond the panel lifetime.
static napi_value Apply(napi_env env, napi_callback_info info) {
  bool applied = false;
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  bool isBuffer = false;
  if (argc != 1 || napi_is_buffer(env, args[0], &isBuffer) != napi_ok || !isBuffer) {
    napi_throw_type_error(env, nullptr, "Expected an Electron native window handle");
    return nullptr;
  }
  void *bytes = nullptr;
  size_t length = 0;
  napi_get_buffer_info(env, args[0], &bytes, &length);
  if (length != sizeof(void *) || ![NSThread isMainThread]) {
    napi_throw_type_error(env, nullptr, "Expected a native window handle on the main thread");
    return nullptr;
  }
  if (@available(macOS 26.0, *)) {
    void *pointer = nullptr;
    std::memcpy(&pointer, bytes, sizeof(pointer));
    if (pointer != nullptr) {
      NSView *view = (__bridge NSView *)pointer;
      NSWindow *window = view.window;
      // Keep Electron's content view and titlebar hierarchy intact. Place the material
      // behind its renderer instead of replacing the NSWindow's content view.
      if (window != nil) {
        for (NSView *child in view.subviews) {
          if ([child isKindOfClass:[NSGlassEffectView class]]) {
            applied = true;
            break;
          }
        }
      }
      if (window != nil && !applied) {
        NSGlassEffectView *glass = [[NSGlassEffectView alloc] initWithFrame:view.bounds];
        glass.style = NSGlassEffectViewStyleRegular;
        glass.cornerRadius = 20;
        glass.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
        window.opaque = NO;
        window.backgroundColor = NSColor.clearColor;
        [view addSubview:glass positioned:NSWindowBelow relativeTo:nil];
        applied = true;
      }
    }
  }
  napi_value result;
  napi_get_boolean(env, applied, &result);
  return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value apply;
  napi_create_function(env, "apply", NAPI_AUTO_LENGTH, Apply, nullptr, &apply);
  napi_set_named_property(env, exports, "apply", apply);
  return exports;
}

NAPI_MODULE(ssh_glass, Init)
