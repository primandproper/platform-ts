---
"@primandproper/notifications": minor
---

Remove the `ErrPlatformNotSupported` export (replaced by `newPlatformNotSupportedError()` and `PLATFORM_NOT_SUPPORTED_MESSAGE`) and add a required `close()` to `PushNotificationSender`. Breaking for importers and implementers. The `secure` config default is now `true`.
