// ModelLogger class for consistent logging across the application
export class ModelLogger {
  private prefix: string;
  private debugEnabled: boolean;

  constructor(prefix: string, debugEnabled = true) {
    this.prefix = `[NanoScribe::${prefix}]`;
    this.debugEnabled = debugEnabled;
  }

  debug(message: string, ...args: any[]) {
    if (this.debugEnabled) {
      console.debug(this.prefix, message, ...args);
    }
  }

  info(message: string, ...args: any[]) {
    console.info(this.prefix, message, ...args);
  }

  warn(message: string, ...args: any[]) {
    console.warn(this.prefix, message, ...args);
  }

  error(message: string, ...args: any[]) {
    console.error(this.prefix, message, ...args);
  }

  group(label: string) {
    console.group(this.prefix + ' ' + label);
  }

  groupEnd() {
    console.groupEnd();
  }
}