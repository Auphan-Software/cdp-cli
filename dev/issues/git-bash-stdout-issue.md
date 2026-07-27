# Git Bash stdout swallowed when running cdp-cli

## Issue
Running `cdp-cli` from Git Bash on Windows produces no output. The command executes but stdout is lost.

## Root Cause
npm creates multiple shim files when installing a global package:
- `cdp-cli` (no extension) - Unix shell script
- `cdp-cli.cmd` - Windows batch file
- `cdp-cli.ps1` - PowerShell script

Git Bash (MSYS2/MinGW) picks up the extensionless `cdp-cli` shell script. When Git Bash executes a shell script as a subprocess, stdout gets swallowed due to a bug/limitation in MSYS2's subprocess stdio handling.

## Investigation Results

| Method | Works? |
|--------|--------|
| `node script.js` (direct) | Yes |
| `bash -c "echo test"` | Yes |
| `source script.sh` | Yes |
| `./script.sh` (subprocess) | No - stdout lost |
| `cdp-cli` (npm shell shim) | No |
| `cdp-cli.cmd` | Yes |
| `powershell -Command "cdp-cli ..."` | Yes |

## The npm Shell Shim
Located at: `C:\Program Files\nodejs\cdp-cli`

```sh
#!/bin/sh
basedir=$(dirname "$(echo "$0" | sed -e 's,\\,/,g')")

case `uname` in
    *CYGWIN*|*MINGW*|*MSYS*)
        if command -v cygpath > /dev/null 2>&1; then
            basedir=`cygpath -w "$basedir"`
        fi
    ;;
esac

if [ -x "$basedir/node" ]; then
  exec "$basedir/node"  "$basedir/node_modules/@auphansoftware/cdp-cli/build/index.js" "$@"
else
  exec node  "$basedir/node_modules/@auphansoftware/cdp-cli/build/index.js" "$@"
fi
```

The `exec` command replaces the shell process with node, and somewhere in this transition the stdout pipe gets lost.

## Solution
Use `cdp-cli.cmd` instead of `cdp-cli` in Git Bash:

```bash
cdp-cli.cmd list-pages
cdp-cli.cmd ready
```

## Why We Can't Fix This in cdp-cli
- The issue is in how npm creates shims, not in our code
- The issue is in Git Bash/MSYS2 subprocess handling, not node
- Changing stdout buffering in node doesn't help because the pipe is broken before our code runs

## Alternative Workarounds
1. Use PowerShell instead of Git Bash
2. Use `powershell -Command "cdp-cli ..."` from Git Bash
3. Add alias: `alias cdp-cli='cdp-cli.cmd'` to `.bashrc`

## Date
2026-01-28
