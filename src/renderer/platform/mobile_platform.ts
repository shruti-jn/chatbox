import WebPlatform from './web_platform'

// OSS builds do not ship a dedicated mobile platform class.
// Exporting a web-backed implementation keeps tests and migration code type-safe.
export default class MobilePlatform extends WebPlatform {}
