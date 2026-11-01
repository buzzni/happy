/**
 * Advertised in machine metadata so a client picks listFilesPage before calling it: on a
 * daemon without the handler the call only fails after happy-server's reconnect grace
 * (aplus-dev-studio specs/remote-file-list-pages).
 */
export const LIST_FILES_PAGE_CAPABILITY = { version: 1 as const };
