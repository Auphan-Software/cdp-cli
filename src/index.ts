#!/usr/bin/env node

/**
 * Chrome DevTools CLI
 * Command-line interface for Chrome DevTools Protocol
 * Optimized for LLM agents with NDJSON output
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { CDPContext } from './context.js';
import { versionString } from './version.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
import * as pages from './commands/pages.js';
import * as debug from './commands/debug.js';
import * as network from './commands/network.js';
import * as input from './commands/input.js';
import * as daemon from './commands/daemon.js';
import * as logs from './commands/logs.js';
import * as lifecycle from './commands/lifecycle.js';
import { outputError } from './output.js';
import { homedir } from 'os';
import {
  validateNavigateParams,
  validateEvalParams,
  validateLogsParams,
  validatePressKeyParams,
  validateFillParams,
  validateLogsDetailParams,
  buildErrorWithHint
} from './validation.js';

const DEFAULT_CDP_URL = 'http://localhost:9222';

// Global error handler for unhandled exceptions
process.on('uncaughtException', (error) => {
  outputError(
    error.message || 'An unexpected error occurred',
    'UNCAUGHT_EXCEPTION',
    { stack: error.stack }
  );
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : undefined;
  outputError(
    message || 'An unhandled promise rejection occurred',
    'UNHANDLED_REJECTION',
    { stack }
  );
  process.exit(1);
});

// Create CLI
const cli = yargs(hideBin(process.argv))
  .scriptName('cdp-cli')
  .version(versionString)
  .usage('Usage: $0 <command> [options]')
  .option('cdp-url', {
    type: 'string',
    description: 'Chrome DevTools Protocol URL',
    default: DEFAULT_CDP_URL
  })
  .demandCommand(1)
  .strict()
  .help()
  .alias('help', 'h')
  .alias('version', 'v')
  .wrap(120)
  .epilog(`Key Features:
  --frame               Target an iframe by CSS selector ("#my-iframe") or index (1 = first iframe).
                        Works on click, fill, select, drag, eval, query, styles, snapshot, dismiss-overlays.
  --text/--nth          Click/drag by visible text with multi-match disambiguation
  --within              Scope element search to a container
  --wait-for            Wait for selector/text/idle after navigation
  --wait-for-navigation Wait for a real document replacement (click, fill, select, press-key, navigate).
                        Watches the frame from --frame; override with --wait-for-frame.
  --wait-for-frame      Frame the waits apply to, by selector or index (defaults to --frame)
  select                Set a <select> by value, --text label, or --index
  --touch               Touch events for mobile testing (click, drag)
  --longpress           Hold before click/drag for mobile patterns

Run "cdp-cli <command> --help" for command-specific options.`)
  .fail((msg, err, yargs) => {
    // Show help when no command provided
    if (msg === 'Not enough non-option arguments: got 0, need at least 1') {
      yargs.showHelp();
      process.exit(0);
    }
    // Custom error handler to output NDJSON format
    if (err) {
      // Validation error from .check() or coerce
      outputError(
        err.message,
        'VALIDATION_ERROR',
        { usage: yargs.help() }
      );
    } else if (msg) {
      // Yargs built-in error (missing command, missing required arg, etc)
      outputError(
        msg,
        'ARGUMENT_ERROR',
        { usage: yargs.help() }
      );
    }
    process.exit(1);
  });

// Page management commands
cli.command(
  'list-pages',
  'List all open browser pages',
  {},
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    await pages.listPages(context);
  }
);

cli.command(
  'new-page [url]',
  'Create a new page/tab',
  (yargs) => {
    return yargs.positional('url', {
      describe: 'URL to navigate to',
      type: 'string'
    });
  },
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    await pages.newPage(context, argv.url as string | undefined);
  }
);

cli.command(
  'navigate <action> <page>',
  'Navigate page (URL, back, forward, reload). Options: --wait-for, --wait-for-text, --wait-for-idle, --wait-for-frame, --timeout',
  (yargs) => {
    return yargs
      .positional('action', {
        describe: 'URL or action (back, forward, reload)',
        type: 'string'
      })
      .positional('page', {
        describe: 'Page ID or title',
        type: 'string'
      })
      .option('wait-for', {
        type: 'string',
        description: 'Wait for CSS selector to appear after navigation',
        alias: 'w'
      })
      .option('wait-for-text', {
        type: 'string',
        description: 'Wait for text to appear in page body'
      })
      .option('wait-for-idle', {
        type: 'boolean',
        description: 'Wait for network idle and document ready',
        default: false
      })
      .option('timeout', {
        type: 'number',
        description: 'Timeout for wait operations in ms',
        alias: 't',
        default: 10000
      })
      .option('wait-for-frame', {
        type: 'string',
        description: 'Frame these waits apply to, by CSS selector or index. Also the frame --wait-for-navigation watches.'
      })
      .option('wait-for-navigation', {
        type: 'boolean',
        description: 'Wait for a real document replacement (not text presence). Watches the frame from --wait-for-frame, else the main frame.',
        default: false
      })
      .check((argv) => {
        const hint = validateNavigateParams(argv.action as string, argv.page as string);
        if (hint.likely) {
          throw new Error(buildErrorWithHint('Invalid parameter order', hint));
        }
        return true;
      });
  },
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    await pages.navigate(
      context,
      argv.action as string,
      argv.page as string,
      {
        waitFor: argv['wait-for'] as string | undefined,
        waitForText: argv['wait-for-text'] as string | undefined,
        waitForIdle: argv['wait-for-idle'] as boolean,
        timeout: argv.timeout as number,
        waitForFrame: argv['wait-for-frame'] as string | undefined,
        waitForNavigation: argv['wait-for-navigation'] as boolean
      }
    );
  }
);

cli.command(
  'close-page <idOrTitle>',
  'Close a page',
  (yargs) => {
    return yargs.positional('idOrTitle', {
      describe: 'Page ID or title',
      type: 'string'
    });
  },
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    await pages.closePage(context, argv.idOrTitle as string);
  }
);

cli.command(
  'resize-window <page> <width> <height>',
  'Resize the Chrome window containing the specified page',
  (yargs) => {
    return yargs
      .positional('page', {
        describe: 'Page ID or title',
        type: 'string'
      })
      .positional('width', {
        describe: 'Window width in pixels',
        type: 'number',
        coerce: (value: unknown) => {
          const num = Number(value);
          if (!Number.isFinite(num) || num <= 0) {
            throw new Error('Width must be a positive number');
          }
          return num;
        }
      })
      .positional('height', {
        describe: 'Window height in pixels',
        type: 'number',
        coerce: (value: unknown) => {
          const num = Number(value);
          if (!Number.isFinite(num) || num <= 0) {
            throw new Error('Height must be a positive number');
          }
          return num;
        }
      })
      .option('state', {
        type: 'string',
        description: 'Window state (normal, maximized, minimized, fullscreen)',
        choices: ['normal', 'maximized', 'minimized', 'fullscreen'] as const
      });
  },
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    await pages.resizeWindow(
      context,
      argv.page as string,
      {
        width: argv.width as number,
        height: argv.height as number,
        state: argv.state as 'normal' | 'maximized' | 'minimized' | 'fullscreen' | undefined
      }
    );
  }
);

// Debug commands
cli.command(
  'list-console <page>',
  'List console messages',
  (yargs) => {
    return yargs
      .positional('page', {
        describe: 'Page ID or title',
        type: 'string'
      })
      .option('type', {
        type: 'string',
        description: 'Filter by message type (log, error, warn, info)',
        alias: 't'
      })
      .option('duration', {
        type: 'number',
        description: 'Collection duration in seconds (0 to stream until interrupted)',
        alias: 'd',
        default: 0
      });
  },
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    await debug.listConsole(context, {
      type: argv.type as string | undefined,
      page: argv.page as string,
      duration: argv.duration as number
    });
  }
);

cli.command(
  'snapshot <page>',
  'Take a page snapshot. Options: --format (ax|text), --frame',
  (yargs) => {
    return yargs
      .positional('page', {
        describe: 'Page ID or title',
        type: 'string'
      })
      .option('format', {
        type: 'string',
        description: 'Snapshot format (ax, text)',
        alias: 'f',
        default: 'ax'
      })
      .option('frame', {
        type: 'string',
        description: 'Target iframe by selector (e.g. "#myframe") or index (1 = first iframe)'
      });
  },
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    await debug.snapshot(context, {
      format: argv.format as string,
      page: argv.page as string,
      frame: argv.frame as string | undefined
    });
  }
);

cli.command(
  'eval <expression> <page>',
  'Evaluate JavaScript expression. Options: --file, --async, --frame',
  (yargs) => {
    return yargs
      .positional('expression', {
        describe: 'JavaScript expression (ignored when --file used)',
        type: 'string'
      })
      .positional('page', {
        describe: 'Page ID or title',
        type: 'string'
      })
      .option('file', {
        alias: 'f',
        type: 'string',
        description: 'Path to JS file to evaluate'
      })
      .option('async', {
        alias: 'a',
        type: 'boolean',
        description: 'Wrap code in async IIFE for await support',
        default: false
      })
      .option('stdin', {
        type: 'boolean',
        description: 'Read JavaScript from stdin instead of expression argument',
        default: false
      })
      .option('frame', {
        type: 'string',
        description: 'Target iframe by selector (e.g. "#myframe") or index (1 = first iframe)'
      })
      .check((argv) => {
        // If --file or --stdin is used, ignore expression validation
        if (!argv.file && !argv.stdin) {
          const hint = validateEvalParams(argv.expression as string, argv.page as string);
          if (hint.likely) {
            throw new Error(buildErrorWithHint('Invalid parameter order', hint));
          }
        }
        return true;
      });
  },
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    await debug.evaluate(context, argv.expression as string, {
      page: argv.page as string,
      file: argv.file as string | undefined,
      async: argv.async as boolean,
      frame: argv.frame as string | undefined,
      stdin: argv.stdin as boolean
    });
  }
);

cli.command(
  'screenshot <page>',
  'Take a screenshot',
  (yargs) => {
    return yargs
      .positional('page', {
        describe: 'Page ID or title',
        type: 'string'
      })
      .option('output', {
        type: 'string',
        description: 'Output file path',
        alias: 'o'
      })
      .option('format', {
        type: 'string',
        description: 'Image format (jpeg, png, webp). Defaults to the output file extension when available.',
        alias: 'f'
      })
      .option('quality', {
        type: 'number',
        description: 'JPEG quality (0-100)',
        alias: 'q',
        default: 90
      })
      .option('scale', {
        type: 'number',
        description: 'Scale factor to resize the image (0 < scale <= 1)',
        alias: 's'
      })
      .option('selector', {
        type: 'string',
        description: 'CSS selector to capture a specific element instead of the full page'
      });
  },
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    await debug.screenshot(context, {
      output: argv.output as string | undefined,
      format: argv.format as string,
      quality: argv.quality as number,
      scale: argv.scale as number | undefined,
      page: argv.page as string,
      selector: argv.selector as string | undefined
    });
  }
);

cli.command(
  'dialog <page>',
  'Check for or handle JavaScript dialogs (alert/confirm/prompt)',
  (yargs) => {
    return yargs
      .positional('page', {
        describe: 'Page ID or title',
        type: 'string'
      })
      .option('dismiss', {
        type: 'boolean',
        description: 'Dismiss (cancel) the dialog',
        alias: 'd'
      })
      .option('accept', {
        type: 'boolean',
        description: 'Accept (OK) the dialog',
        alias: 'a'
      })
      .option('prompt-text', {
        type: 'string',
        description: 'Text to enter for prompt dialogs before accepting',
        alias: 't'
      });
  },
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    await debug.dialog(context, {
      page: argv.page as string,
      dismiss: argv.dismiss as boolean | undefined,
      accept: argv.accept as boolean | undefined,
      promptText: argv['prompt-text'] as string | undefined
    });
  }
);

// Network commands
cli.command(
  'list-network <page>',
  'List network requests',
  (yargs) => {
    return yargs
      .positional('page', {
        describe: 'Page ID or title',
        type: 'string'
      })
      .option('type', {
        type: 'string',
        description: 'Filter by request type (xhr, fetch, script, etc)',
        alias: 't'
      })
      .option('duration', {
        type: 'number',
        description: 'Collection duration in seconds (0 to stream until interrupted)',
        alias: 'd',
        default: 0
      });
  },
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    await network.listNetwork(context, {
      type: argv.type as string | undefined,
      page: argv.page as string,
      duration: argv.duration as number
    });
  }
);

// Input commands
cli.command(
  'click [selector] <page>',
  'Click an element. Options: --text, --nth, --within, --frame, --double, --longpress, --touch, --force',
  (yargs) => {
    return yargs
      .positional('selector', {
        describe: 'CSS selector',
        type: 'string'
      })
      .positional('page', {
        describe: 'Page ID or title',
        type: 'string'
      })
      .option('double', {
        type: 'boolean',
        description: 'Perform double click',
        alias: 'd',
        default: false
      })
      .option('longpress', {
        type: 'number',
        description: 'Hold mouse button for N seconds before release (defaults to 1 when flag is present without a value)',
        coerce: (value: unknown) => {
          if (value === true) {
            return 1;
          }
          if (value === undefined || value === null) {
            return undefined;
          }
          if (value === '') {
            return 1;
          }
          const num = Number(value);
          if (!Number.isFinite(num) || num < 0) {
            throw new Error('--longpress must be a non-negative number');
          }
          return num;
        }
      })
      .option('text', {
        type: 'string',
        description: 'Match element by visible text instead of CSS selector'
      })
      .option('match', {
        type: 'string',
        description: 'Text matching strategy (exact, contains, regex)',
        choices: ['exact', 'contains', 'regex'] as const,
        default: 'exact'
      })
      .option('case-sensitive', {
        type: 'boolean',
        description: 'Treat text match as case-sensitive',
        default: false
      })
      .option('nth', {
        type: 'number',
        description: 'Select the Nth match when multiple elements match',
        coerce: (value: unknown) => {
          if (value === undefined || value === null || value === '') {
            return undefined;
          }
          const num = Number(value);
          if (!Number.isInteger(num) || num < 1) {
            throw new Error('--nth must be a positive integer');
          }
          return num;
        }
      })
      .option('within', {
        type: 'string',
        description: 'CSS selector to scope the search within a container'
      })
      .option('touch', {
        type: 'boolean',
        description: 'Use touch events instead of mouse events',
        default: false
      })
      .option('frame', {
        type: 'string',
        description: 'Target iframe by selector (e.g. "#myframe") or index (1 = first iframe)'
      })
      .option('force', {
        type: 'boolean',
        description: 'Click even when another element covers the click point',
        default: false
      })
      .option('wait-for', {
        type: 'string',
        description: 'CSS selector to wait for after click'
      })
      .option('wait-for-text', {
        type: 'string',
        description: 'Text to wait for after click'
      })
      .option('wait-for-idle', {
        type: 'boolean',
        description: 'Wait for network idle after click',
        default: false
      })
      .option('wait-for-frame', {
        type: 'string',
        description: 'Frame these waits apply to, by CSS selector or index (defaults to --frame). Also the frame --wait-for-navigation watches.'
      })
      .option('wait-for-navigation', {
        type: 'boolean',
        description: 'Wait for a real document replacement (form POST, link, redirect). Watches the frame from --frame; override with --wait-for-frame.',
        default: false
      })
      .option('timeout', {
        type: 'number',
        description: 'Timeout for wait operations in ms (default: 10000)'
      })
      .check((argv) => {
        const hasSelector = typeof argv.selector === 'string' && argv.selector.length > 0;
        const hasText = typeof argv.text === 'string' && argv.text.length > 0;
        if (!hasSelector && !hasText) {
          throw new Error('Provide either a CSS selector or --text');
        }
        if (hasSelector && hasText) {
          throw new Error('CSS selector and --text are mutually exclusive');
        }
        if (
          argv.double === true &&
          typeof argv.longpress === 'number' &&
          argv.longpress > 0
        ) {
          throw new Error('--double cannot be combined with --longpress');
        }
        if (argv.touch === true && argv.double === true) {
          throw new Error('--touch cannot be combined with --double');
        }
        return true;
      });
  },
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    await input.click(
      context,
      {
        selector: argv.selector as string | undefined,
        text: argv.text as string | undefined,
        match: argv.match as 'exact' | 'contains' | 'regex',
        caseSensitive: argv.caseSensitive as boolean,
        nth: argv.nth as number | undefined,
        within: argv.within as string | undefined
      },
      {
        page: argv.page as string,
        double: argv.double as boolean,
        longpress: argv.longpress as number | undefined,
        touch: argv.touch as boolean,
        frame: argv.frame as string | undefined,
        force: argv.force as boolean,
        waitFor: argv.waitFor as string | undefined,
        waitForText: argv.waitForText as string | undefined,
        waitForIdle: argv.waitForIdle as boolean | undefined,
        waitForFrame: argv.waitForFrame as string | undefined,
        waitForNavigation: argv.waitForNavigation as boolean | undefined,
        timeout: argv.timeout as number | undefined
      }
    );
  }
);

cli.command(
  'fill <selector> <value> <page>',
  'Fill an input element. Options: --nth, --within, --frame',
  (yargs) => {
    return yargs
      .positional('selector', {
        describe: 'CSS selector',
        type: 'string'
      })
      .positional('value', {
        describe: 'Value to fill',
        type: 'string'
      })
      .positional('page', {
        describe: 'Page ID or title',
        type: 'string'
      })
      .option('nth', {
        describe: 'Select nth match (1-based) when multiple elements match',
        type: 'number'
      })
      .option('within', {
        type: 'string',
        description: 'CSS selector to scope the search within a container'
      })
      .option('frame', {
        type: 'string',
        description: 'Target iframe by selector (e.g. "#myframe") or index (1 = first iframe)'
      })
      .option('wait-for', {
        type: 'string',
        description: 'CSS selector to wait for after fill'
      })
      .option('wait-for-text', {
        type: 'string',
        description: 'Text to wait for after fill'
      })
      .option('wait-for-idle', {
        type: 'boolean',
        description: 'Wait for network idle after fill',
        default: false
      })
      .option('wait-for-frame', {
        type: 'string',
        description: 'Frame these waits apply to, by CSS selector or index (defaults to --frame). Also the frame --wait-for-navigation watches.'
      })
      .option('wait-for-navigation', {
        type: 'boolean',
        description: 'Wait for a real document replacement (for fills that submit). Watches the frame from --frame; override with --wait-for-frame.',
        default: false
      })
      .option('timeout', {
        type: 'number',
        description: 'Timeout for wait operations in ms (default: 10000)'
      })
      .check((argv) => {
        const hint = validateFillParams(
          argv.selector as string,
          argv.value as string,
          argv.page as string
        );
        if (hint.likely) {
          throw new Error(buildErrorWithHint('Invalid parameter order', hint));
        }
        return true;
      });
  },
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    await input.fill(
      context,
      argv.selector as string,
      argv.value as string,
      {
        page: argv.page as string,
        nth: argv.nth as number | undefined,
        within: argv.within as string | undefined,
        frame: argv.frame as string | undefined,
        waitFor: argv.waitFor as string | undefined,
        waitForText: argv.waitForText as string | undefined,
        waitForIdle: argv.waitForIdle as boolean | undefined,
        waitForFrame: argv.waitForFrame as string | undefined,
        waitForNavigation: argv.waitForNavigation as boolean | undefined,
        timeout: argv.timeout as number | undefined
      }
    );
  }
);

cli.command(
  'select <selector> <valueOrPage> [page]',
  'Set a <select> element. Usage: select <selector> <value> <page>  OR  select <selector> <page> --text "Label" | --index N',
  (yargs) => {
    return yargs
      .positional('selector', {
        describe: 'CSS selector for the <select> element',
        type: 'string'
      })
      .positional('valueOrPage', {
        describe: 'Option value, or the page when --text/--index is used',
        type: 'string'
      })
      .positional('page', {
        describe: 'Page ID or title (omit when matching by --text/--index)',
        type: 'string'
      })
      .option('text', {
        type: 'string',
        description: 'Match the option by its visible label instead of its value'
      })
      .option('index', {
        type: 'number',
        description: 'Match the Nth option (1-based, same convention as --nth)',
        coerce: (value: unknown) => {
          if (value === undefined || value === null || value === '') {
            return undefined;
          }
          const num = Number(value);
          if (!Number.isInteger(num) || num < 1) {
            throw new Error('--index must be a positive integer (1-based)');
          }
          return num;
        }
      })
      .option('match', {
        type: 'string',
        description: 'Label matching strategy for --text (exact, contains, regex)',
        choices: ['exact', 'contains', 'regex'] as const,
        default: 'exact'
      })
      .option('case-sensitive', {
        type: 'boolean',
        description: 'Treat --text match as case-sensitive',
        default: false
      })
      .option('nth', {
        type: 'number',
        description: 'Select the Nth <select> element when the selector matches several (1-based)'
      })
      .option('within', {
        type: 'string',
        description: 'CSS selector to scope the search within a container'
      })
      .option('frame', {
        type: 'string',
        description: 'Target iframe by selector (e.g. "#myframe") or index (1 = first iframe)'
      })
      .option('wait-for', {
        type: 'string',
        description: 'CSS selector to wait for after selecting'
      })
      .option('wait-for-text', {
        type: 'string',
        description: 'Text to wait for after selecting'
      })
      .option('wait-for-idle', {
        type: 'boolean',
        description: 'Wait for network idle after selecting',
        default: false
      })
      .option('wait-for-frame', {
        type: 'string',
        description: 'Frame these waits apply to, by CSS selector or index (defaults to --frame). Also the frame --wait-for-navigation watches.'
      })
      .option('wait-for-navigation', {
        type: 'boolean',
        description: 'Wait for a real document replacement (for selects that submit on change). Watches the frame from --frame; override with --wait-for-frame.',
        default: false
      })
      .option('timeout', {
        type: 'number',
        description: 'Timeout for wait operations in ms (default: 10000)'
      })
      .check((argv) => {
        const hasText = typeof argv.text === 'string' && argv.text.length > 0;
        const hasIndex = typeof argv.index === 'number';
        const byFlag = hasText || hasIndex;

        if (hasText && hasIndex) {
          throw new Error('--text and --index are mutually exclusive');
        }

        // Three positionals means a value was given; two means the second one
        // is the page and the option must be identified by --text/--index.
        const gaveValue = typeof argv.page === 'string' && argv.page.length > 0;

        if (gaveValue && byFlag) {
          throw new Error(
            'A positional value cannot be combined with --text/--index. ' +
            'Use: select <selector> <value> <page>  OR  select <selector> <page> --text "Label"'
          );
        }

        if (!gaveValue && !byFlag) {
          throw new Error(
            'Provide the option to select: select <selector> <value> <page>  OR  select <selector> <page> --text "Label" | --index N'
          );
        }

        return true;
      });
  },
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);

    // Resolved by arity: with three positionals the middle one is the value,
    // with two the second is the page and --text/--index names the option.
    const gaveValue = typeof argv.page === 'string' && (argv.page as string).length > 0;
    const pageRef = gaveValue ? (argv.page as string) : (argv.valueOrPage as string);
    const value = gaveValue ? (argv.valueOrPage as string) : undefined;

    await input.selectOption(
      context,
      argv.selector as string,
      {
        value,
        text: argv.text as string | undefined,
        index: argv.index as number | undefined,
        match: argv.match as 'exact' | 'contains' | 'regex',
        caseSensitive: argv.caseSensitive as boolean
      },
      {
        page: pageRef,
        nth: argv.nth as number | undefined,
        within: argv.within as string | undefined,
        frame: argv.frame as string | undefined,
        waitFor: argv.waitFor as string | undefined,
        waitForText: argv.waitForText as string | undefined,
        waitForIdle: argv.waitForIdle as boolean | undefined,
        waitForFrame: argv.waitForFrame as string | undefined,
        waitForNavigation: argv.waitForNavigation as boolean | undefined,
        timeout: argv.timeout as number | undefined
      }
    );
  }
);

cli.command(
  'press-key <key> <page>',
  'Press a keyboard key. Options: --wait-for, --wait-for-text, --wait-for-navigation, --timeout',
  (yargs) => {
    return yargs
      .positional('key', {
        describe: 'Key name (enter, tab, escape, etc)',
        type: 'string'
      })
      .positional('page', {
        describe: 'Page ID or title',
        type: 'string'
      })
      .option('wait-for', {
        type: 'string',
        description: 'CSS selector to wait for after the keystroke'
      })
      .option('wait-for-text', {
        type: 'string',
        description: 'Text to wait for after the keystroke'
      })
      .option('wait-for-idle', {
        type: 'boolean',
        description: 'Wait for network idle after the keystroke',
        default: false
      })
      .option('wait-for-frame', {
        type: 'string',
        description: 'Frame these waits apply to, by CSS selector or index (defaults to --frame). Also the frame --wait-for-navigation watches.'
      })
      .option('wait-for-navigation', {
        type: 'boolean',
        description: 'Wait for a real document replacement (Enter submitting a form). Watches the frame from --wait-for-frame, else the main frame.',
        default: false
      })
      .option('timeout', {
        type: 'number',
        description: 'Timeout for wait operations in ms (default: 10000)'
      })
      .check((argv) => {
        const hint = validatePressKeyParams(argv.key as string, argv.page as string);
        if (hint.likely) {
          throw new Error(buildErrorWithHint('Invalid parameter order', hint));
        }
        return true;
      });
  },
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    await input.pressKey(context, argv.key as string, {
      page: argv.page as string,
      waitFor: argv.waitFor as string | undefined,
      waitForText: argv.waitForText as string | undefined,
      waitForIdle: argv.waitForIdle as boolean | undefined,
      waitForFrame: argv.waitForFrame as string | undefined,
      waitForNavigation: argv.waitForNavigation as boolean | undefined,
      timeout: argv.timeout as number | undefined
    });
  }
);

cli.command(
  'drag <from> <to> <page>',
  'Drag from one element/position to another. Options: --touch, --longpress, --steps, --duration, --text, --to-text, --frame',
  (yargs) => {
    return yargs
      .positional('from', {
        describe: 'Source: CSS selector or x,y coordinates',
        type: 'string'
      })
      .positional('to', {
        describe: 'Destination: CSS selector or x,y coordinates',
        type: 'string'
      })
      .positional('page', {
        describe: 'Page ID or title',
        type: 'string'
      })
      .option('touch', {
        type: 'boolean',
        description: 'Use touch events instead of mouse events',
        default: false
      })
      .option('longpress', {
        type: 'number',
        description: 'Hold at start position before dragging (seconds)',
        coerce: (value: unknown) => {
          if (value === true) return 1;
          if (value === undefined || value === null || value === '') return undefined;
          const num = Number(value);
          if (!Number.isFinite(num) || num < 0) {
            throw new Error('--longpress must be a non-negative number');
          }
          return num;
        }
      })
      .option('steps', {
        type: 'number',
        description: 'Number of intermediate move events',
        default: 10
      })
      .option('duration', {
        type: 'number',
        description: 'Total drag duration in milliseconds',
        default: 300
      })
      .option('text', {
        type: 'string',
        description: 'Match source element by visible text'
      })
      .option('to-text', {
        type: 'string',
        description: 'Match destination element by visible text'
      })
      .option('match', {
        type: 'string',
        description: 'Text matching strategy (exact, contains, regex)',
        choices: ['exact', 'contains', 'regex'] as const,
        default: 'exact'
      })
      .option('case-sensitive', {
        type: 'boolean',
        description: 'Treat text match as case-sensitive',
        default: false
      })
      .option('nth', {
        type: 'number',
        description: 'Select Nth source match'
      })
      .option('to-nth', {
        type: 'number',
        description: 'Select Nth destination match'
      })
      .option('within', {
        type: 'string',
        description: 'CSS selector to scope source search'
      })
      .option('to-within', {
        type: 'string',
        description: 'CSS selector to scope destination search'
      })
      .option('frame', {
        type: 'string',
        description: 'Target iframe by selector (e.g. "#myframe") - applies to both source and destination'
      });
  },
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);

    // Parse from target
    const fromStr = argv.from as string;
    const coordsFrom = fromStr.match(/^(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/);
    const fromTarget = coordsFrom
      ? { x: parseFloat(coordsFrom[1]), y: parseFloat(coordsFrom[2]) }
      : {
          selector: argv.text ? undefined : fromStr,
          text: argv.text as string | undefined,
          match: argv.match as 'exact' | 'contains' | 'regex',
          caseSensitive: argv.caseSensitive as boolean,
          nth: argv.nth as number | undefined,
          within: argv.within as string | undefined
        };

    // Parse to target
    const toStr = argv.to as string;
    const coordsTo = toStr.match(/^(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/);
    const toTarget = coordsTo
      ? { x: parseFloat(coordsTo[1]), y: parseFloat(coordsTo[2]) }
      : {
          selector: argv.toText ? undefined : toStr,
          text: argv.toText as string | undefined,
          match: argv.match as 'exact' | 'contains' | 'regex',
          caseSensitive: argv.caseSensitive as boolean,
          nth: argv.toNth as number | undefined,
          within: argv.toWithin as string | undefined
        };

    await input.drag(context, fromTarget, toTarget, {
      page: argv.page as string,
      touch: argv.touch as boolean,
      longpress: argv.longpress as number | undefined,
      steps: argv.steps as number,
      duration: argv.duration as number,
      frame: argv.frame as string | undefined
    });
  }
);

// Daemon commands
cli.command(
  'daemon <action>',
  'Manage the CDP daemon (start, stop, status)',
  (yargs) => {
    return yargs.positional('action', {
      describe: 'Action to perform',
      type: 'string',
      choices: ['start', 'stop', 'status']
    })
    .option('buffer-size', {
      type: 'number',
      description: 'Max log entries per page (default: 500)',
      default: 500
    });
  },
  async (argv) => {
    const action = argv.action as string;
    if (action === 'start') {
      await daemon.startDaemon({
        cdpUrl: argv['cdp-url'] as string,
        bufferSize: argv['buffer-size'] as number
      });
    } else if (action === 'stop') {
      await daemon.stopDaemon();
    } else if (action === 'status') {
      await daemon.daemonStatus();
    }
  }
);

// Logs commands
cli.command(
  'logs <type> <page>',
  'Get logs from daemon (console, network, clear)',
  (yargs) => {
    return yargs
      .positional('type', {
        describe: 'Log type',
        type: 'string',
        choices: ['console', 'network', 'clear']
      })
      .positional('page', {
        describe: 'Page ID or title',
        type: 'string'
      })
      .option('last', {
        type: 'number',
        description: 'Get last N entries (0 for all)',
        alias: 'n',
        default: 20
      })
      .option('filter', {
        type: 'string',
        description: 'Filter by type (log/error/warn for console, xhr/fetch/etc for network)',
        alias: 'f'
      })
      .check((argv) => {
        const hint = validateLogsParams(argv.type as string, argv.page as string);
        if (hint.likely) {
          throw new Error(buildErrorWithHint('Invalid parameter order', hint));
        }
        return true;
      });
  },
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    const logType = argv.type as string;

    if (logType === 'console') {
      await logs.getConsoleLogs(context, {
        page: argv.page as string,
        last: argv.last as number | undefined,
        type: argv.filter as string | undefined
      });
    } else if (logType === 'network') {
      await logs.getNetworkLogs(context, {
        page: argv.page as string,
        last: argv.last as number | undefined,
        type: argv.filter as string | undefined
      });
    } else if (logType === 'clear') {
      await logs.clearLogs(context, {
        page: argv.page as string
      });
    }
  }
);

cli.command(
  'logs-detail <messageId> <page>',
  'Get console message details with stack trace',
  (yargs) => {
    return yargs
      .positional('messageId', {
        describe: 'Console message ID',
        type: 'number'
      })
      .positional('page', {
        describe: 'Page ID or title',
        type: 'string'
      })
      .check((argv) => {
        const hint = validateLogsDetailParams(argv.messageId as number, argv.page as string);
        if (hint.likely) {
          throw new Error(buildErrorWithHint('Invalid parameter order', hint));
        }
        return true;
      });
  },
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    await logs.getConsoleDetail(context, {
      page: argv.page as string,
      messageId: argv.messageId as number
    });
  }
);

// Status command
cli.command(
  'status',
  'Check daemon and Chrome connection status',
  () => {},
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    await debug.status(context);
  }
);

// Ready command
cli.command(
  'ready',
  'Launch Chrome + start daemon + return pages',
  (yargs) => {
    return yargs
      .option('profile', {
        alias: 'p',
        type: 'string',
        description: 'Chrome profile directory',
        default: join(homedir(), 'cdp-cli-profile')
      })
      .option('port', {
        type: 'number',
        description: 'CDP port',
        default: 9222
      });
  },
  async (argv) => {
    await lifecycle.ready({
      profile: argv.profile as string,
      port: argv.port as number,
      cdpUrl: argv['cdp-url'] as string
    });
  }
);

// Query command
cli.command(
  'query <selector> <page>',
  'Query DOM elements. Options: --text, --html, --attrs, --styles, --all, --frame',
  (yargs) => {
    return yargs
      .positional('selector', {
        describe: 'CSS selector',
        type: 'string'
      })
      .positional('page', {
        describe: 'Page ID or title',
        type: 'string'
      })
      .option('text', {
        type: 'boolean',
        description: 'Return textContent',
        default: false
      })
      .option('html', {
        type: 'boolean',
        description: 'Return innerHTML (trimmed, max 2000 chars)',
        default: false
      })
      .option('attrs', {
        type: 'boolean',
        description: 'Return all attributes as key-value pairs',
        default: false
      })
      .option('styles', {
        type: 'string',
        description: 'Return specified computed style properties (comma-separated, e.g. color,fontSize)'
      })
      .option('all', {
        type: 'boolean',
        description: 'Query all matching elements (querySelectorAll)',
        default: false
      })
      .option('frame', {
        type: 'string',
        description: 'Target iframe by selector or index'
      });
  },
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    await debug.query(context, argv.selector as string, {
      page: argv.page as string,
      text: argv.text as boolean,
      html: argv.html as boolean,
      attrs: argv.attrs as boolean,
      styles: argv.styles as string | undefined,
      all: argv.all as boolean,
      frame: argv.frame as string | undefined
    });
  }
);

// Styles command
cli.command(
  'styles <selector> <page>',
  'Extract computed styles. Options: --compare-siblings, --props, --frame',
  (yargs) => {
    return yargs
      .positional('selector', {
        describe: 'CSS selector',
        type: 'string'
      })
      .positional('page', {
        describe: 'Page ID or title',
        type: 'string'
      })
      .option('compare-siblings', {
        type: 'boolean',
        description: 'Include parent and sibling computed styles for comparison',
        default: false
      })
      .option('props', {
        type: 'string',
        description: 'CSS properties to extract (comma-separated, default: color,fontSize,fontWeight,textAlign,margin,padding,lineHeight,display)'
      })
      .option('frame', {
        type: 'string',
        description: 'Target iframe by selector or index'
      });
  },
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    await debug.styles(context, argv.selector as string, {
      page: argv.page as string,
      compareSiblings: argv['compare-siblings'] as boolean,
      props: argv.props as string | undefined,
      frame: argv.frame as string | undefined
    });
  }
);

// Emulate command
cli.command(
  'emulate <device> <page>',
  'Emulate a device (ipad, iphone, desktop). Options: --width, --height, --scale, --ua, --touch',
  (yargs) => {
    return yargs
      .positional('device', {
        describe: 'Device preset (ipad, iphone, desktop) or custom name with flags',
        type: 'string'
      })
      .positional('page', {
        describe: 'Page ID or title',
        type: 'string'
      })
      .option('width', {
        type: 'number',
        description: 'Override viewport width'
      })
      .option('height', {
        type: 'number',
        description: 'Override viewport height'
      })
      .option('scale', {
        type: 'number',
        description: 'Device scale factor (deviceScaleFactor)'
      })
      .option('ua', {
        type: 'string',
        description: 'Custom user agent string'
      })
      .option('touch', {
        type: 'boolean',
        description: 'Enable touch emulation'
      });
  },
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    await debug.emulate(context, argv.device as string, {
      page: argv.page as string,
      width: argv.width as number | undefined,
      height: argv.height as number | undefined,
      scale: argv.scale as number | undefined,
      ua: argv.ua as string | undefined,
      touch: argv.touch as boolean | undefined,
    });
  }
);

// Dismiss overlays command
cli.command(
  'dismiss-overlays <page>',
  'Auto-dismiss toasts, notifications, and modal overlays',
  (yargs) => {
    return yargs
      .positional('page', {
        describe: 'Page ID or title',
        type: 'string'
      })
      .option('frame', {
        type: 'string',
        description: 'Target iframe by selector or index'
      });
  },
  async (argv) => {
    const context = new CDPContext(argv['cdp-url'] as string);
    await debug.dismissOverlays(context, {
      page: argv.page as string,
      frame: argv.frame as string | undefined
    });
  }
);

// Parse and execute
cli.parse();
