#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later

set -eu

test "${1:-}" = --user
shift
case "${1:-}" in
  is-active) printf '%s\n' active ;;
  is-enabled) printf '%s\n' enabled ;;
  daemon-reload|start|stop|restart|enable|disable) ;;
  *) exit 2 ;;
esac

