#!/bin/bash
# Fixed package launcher: never evaluate argv as shell text.
set -euo pipefail
if [[ ${1:-} == --inside ]]; then
    shift
    apply=$1 filter=$2 http=$3 socks=$4 mcp=$5
    shift 5
    if [[ -n $http ]]; then
        socat TCP-LISTEN:3128,bind=127.0.0.1,fork,reuseaddr "UNIX-CONNECT:$http" >/dev/null 2>&1 &
        socat TCP-LISTEN:1080,bind=127.0.0.1,fork,reuseaddr "UNIX-CONNECT:$socks" >/dev/null 2>&1 &
    fi
    if [[ -n $mcp ]]; then
        socat TCP-LISTEN:3129,bind=127.0.0.1,fork,reuseaddr "UNIX-CONNECT:$mcp" >/dev/null 2>&1 &
    fi
    exec "$apply" "$filter" "$@"
fi
file=$1
directory=${file%/*}
[[ -f $file && ! -L $file && -O $file && -d $directory && ! -L $directory && -O $directory ]] || exit 125
if [[ $OSTYPE == darwin* ]]; then
    [[ $(/usr/bin/stat -f %Lp "$file") == 600 && $(/usr/bin/stat -f %Lp "$directory") == 700 ]] || exit 125
else
    [[ $(/usr/bin/stat -c %a "$file") == 600 && $(/usr/bin/stat -c %a "$directory") == 700 ]] || exit 125
fi
# Bash 3 (macOS) also supports read -d, unlike mapfile.
argv=()
while IFS= read -r -d '' arg; do argv+=("$arg"); done < "$file"
rm -- "$file"
[[ ${#argv[@]} -gt 0 ]] || exit 125
exec "${argv[@]}"
