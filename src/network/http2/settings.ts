/**
 * HTTP/2 Frame Synchronization
 * Browser-native SETTINGS + WINDOW_UPDATE sequences after connection preface.
 */
export interface Http2SettingsProfile {
  id: string;
  /** SETTINGS parameters in send order */
  settings: Array<{ id: number; value: number; name: string }>;
  initialWindowUpdate?: number;
  /** Enable push — browsers typically 0 */
  enablePush: number;
}

/** Chrome-like SETTINGS (matches JA4 chrome profiles) */
export const CHROME_HTTP2_SETTINGS: Http2SettingsProfile = {
  id: 'chrome-126',
  settings: [
    { id: 1, value: 65536, name: 'HEADER_TABLE_SIZE' },
    { id: 2, value: 0, name: 'ENABLE_PUSH' },
    { id: 3, value: 1000, name: 'MAX_CONCURRENT_STREAMS' },
    { id: 4, value: 6291456, name: 'INITIAL_WINDOW_SIZE' },
    { id: 6, value: 262144, name: 'MAX_HEADER_LIST_SIZE' },
  ],
  initialWindowUpdate: 15663105,
  enablePush: 0,
};

export const FIREFOX_HTTP2_SETTINGS: Http2SettingsProfile = {
  id: 'firefox-127',
  settings: [
    { id: 1, value: 65536, name: 'HEADER_TABLE_SIZE' },
    { id: 2, value: 0, name: 'ENABLE_PUSH' },
    { id: 4, value: 131072, name: 'INITIAL_WINDOW_SIZE' },
    { id: 5, value: 16384, name: 'MAX_FRAME_SIZE' },
  ],
  enablePush: 0,
};

export function selectHttp2Profile(browser: 'chrome' | 'firefox' | 'safari' | 'edge'): Http2SettingsProfile {
  if (browser === 'firefox') return FIREFOX_HTTP2_SETTINGS;
  return CHROME_HTTP2_SETTINGS;
}
