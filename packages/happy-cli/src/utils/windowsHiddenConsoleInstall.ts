/**
 * Imported first by the CLI entry, so the Windows hidden-console default is in place before any other
 * module can start a child process. A separate module because ES imports are evaluated before the
 * importing file's own statements. See windowsHiddenConsole.ts.
 */
import { installWindowsHiddenConsoleDefault } from './windowsHiddenConsole';

installWindowsHiddenConsoleDefault();
