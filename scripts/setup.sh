#!/bin/bash
#
# setup.sh — Install or uninstall the pixel-agents approval hook for Claude Code.
#
# What this does:
#   --install (default):
#     1. Adds a PreToolUse hook to Claude Code's settings.json that routes
#        every tool call through the pixel-agents web UI for approval.
#     2. Adds permissions.allow entries so Claude Code's built-in terminal
#        prompts are disabled — the hook becomes the sole approval gate.
#     3. The hook is fail-open: if the pixel-agents server isn't running,
#        tool calls proceed without blocking.
#
#   --uninstall:
#     1. Removes the pixel-agents hook from settings.json.
#     2. Removes the auto-allow permissions that were added during install,
#        restoring Claude Code's default terminal-based approval prompts.
#     3. Cleans up any session approval caches from /tmp.
#
# Usage:
#   ./setup.sh [--install|--uninstall]
#
# The hook can be installed globally (~/.claude/settings.json) or for a
# specific project (<project>/.claude/settings.json).
#

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PIXEL_AGENTS_DIR=$(dirname "$SCRIPT_DIR")
HOOK_SCRIPT="$PIXEL_AGENTS_DIR/scripts/approve-hook.sh"

# --- Parse flags --------------------------------------------------------------
ACTION="install"
if [[ "${1:-}" == "--uninstall" ]]; then
  ACTION="uninstall"
elif [[ "${1:-}" == "--install" ]]; then
  ACTION="install"
elif [[ -n "${1:-}" ]]; then
  echo "Usage: $0 [--install|--uninstall]"
  exit 1
fi

# --- Ask for scope (global vs project) ----------------------------------------
echo ""
if [[ "$ACTION" == "install" ]]; then
  echo "Where would you like to install the pixel-agents approval hook?"
else
  echo "Where would you like to uninstall the pixel-agents approval hook from?"
fi
echo "  1) Global (~/.claude/settings.json)"
echo "  2) A specific project"
echo ""
read -rp "Choice [1/2]: " choice

if [[ "$choice" == "2" ]]; then
  read -rp "Enter the project directory path: " PROJECT_DIR
  PROJECT_DIR="${PROJECT_DIR/#\~/$HOME}"
  if [[ ! -d "$PROJECT_DIR" ]]; then
    echo "Error: Directory $PROJECT_DIR does not exist."
    exit 1
  fi
  SETTINGS_DIR="$PROJECT_DIR/.claude"
  SETTINGS_FILE="$SETTINGS_DIR/settings.json"
else
  SETTINGS_DIR="$HOME/.claude"
  SETTINGS_FILE="$SETTINGS_DIR/settings.json"
fi

# =============================================================================
# INSTALL
# =============================================================================
if [[ "$ACTION" == "install" ]]; then

  # Verify approve-hook.sh exists
  if [[ ! -f "$HOOK_SCRIPT" ]]; then
    echo "Error: approve-hook.sh not found at $HOOK_SCRIPT"
    exit 1
  fi

  # Make approve-hook.sh executable if not already
  if [[ ! -x "$HOOK_SCRIPT" ]]; then
    chmod +x "$HOOK_SCRIPT"
    echo "Made $HOOK_SCRIPT executable."
  fi

  # Create .claude directory if needed
  if [[ ! -d "$SETTINGS_DIR" ]]; then
    mkdir -p "$SETTINGS_DIR"
    echo "Created $SETTINGS_DIR"
  fi

  # Merge hook + permissions into settings.json
  python3 -c "
import json, sys, os

settings_file = '$SETTINGS_FILE'
hook_command = '$HOOK_SCRIPT'

# Read existing settings or start fresh
if os.path.exists(settings_file):
    with open(settings_file, 'r') as f:
        settings = json.load(f)
else:
    settings = {}

# --- Add the PreToolUse hook ---
if 'hooks' not in settings:
    settings['hooks'] = {}
if 'PreToolUse' not in settings['hooks']:
    settings['hooks']['PreToolUse'] = []

hook_entry = {
    'matcher': '',
    'hooks': [
        {
            'type': 'command',
            'command': hook_command,
            'timeout': 3600
        }
    ]
}

# Check for duplicate
already_exists = False
for group in settings['hooks']['PreToolUse']:
    if 'hooks' in group:
        for h in group['hooks']:
            if h.get('type') == 'command' and h.get('command') == hook_command:
                already_exists = True
                break

if already_exists:
    print('Hook already configured — skipping hook addition.')
else:
    settings['hooks']['PreToolUse'].append(hook_entry)
    print('Hook added.')

# --- Add auto-allow permissions ---
# These disable Claude Code's built-in terminal prompts so the hook
# is the sole approval gate. Without these, users get double-prompted.
auto_allow = [
    'Bash(*)', 'Read(*)', 'Edit(*)', 'Write(*)',
    'Grep(*)', 'Glob(*)', 'Agent(*)',
    'WebFetch(*)', 'WebSearch(*)'
]
if 'permissions' not in settings:
    settings['permissions'] = {}
if 'allow' not in settings['permissions']:
    settings['permissions']['allow'] = []

existing = set(settings['permissions']['allow'])
added = 0
for perm in auto_allow:
    if perm not in existing:
        settings['permissions']['allow'].append(perm)
        added += 1

if added > 0:
    print(f'Added {added} auto-allow permissions.')
else:
    print('Permissions already configured — skipping.')

# Write back
with open(settings_file, 'w') as f:
    json.dump(settings, f, indent=2)
    f.write('\n')
"

  echo ""
  echo "Installed to: $SETTINGS_FILE"
  echo ""
  echo "Reminder: The pixel-agents server must be running at http://localhost:3456"
  echo "Start it with: cd $PIXEL_AGENTS_DIR && npm start"
  echo ""
  echo "To uninstall later: $0 --uninstall"

# =============================================================================
# UNINSTALL
# =============================================================================
else

  if [[ ! -f "$SETTINGS_FILE" ]]; then
    echo "No settings file found at $SETTINGS_FILE — nothing to uninstall."
    exit 0
  fi

  python3 -c "
import json, sys, os

settings_file = '$SETTINGS_FILE'
hook_command = '$HOOK_SCRIPT'

with open(settings_file, 'r') as f:
    settings = json.load(f)

removed_hook = False
removed_perms = False

# --- Remove the PreToolUse hook ---
if 'hooks' in settings and 'PreToolUse' in settings['hooks']:
    original_len = len(settings['hooks']['PreToolUse'])
    settings['hooks']['PreToolUse'] = [
        group for group in settings['hooks']['PreToolUse']
        if not any(
            h.get('type') == 'command' and h.get('command') == hook_command
            for h in group.get('hooks', [])
        )
    ]
    if len(settings['hooks']['PreToolUse']) < original_len:
        removed_hook = True
        print('Removed pixel-agents hook.')
    else:
        print('Hook not found — skipping.')

    # Clean up empty structures
    if not settings['hooks']['PreToolUse']:
        del settings['hooks']['PreToolUse']
    if not settings['hooks']:
        del settings['hooks']

# --- Remove auto-allow permissions ---
auto_allow = {
    'Bash(*)', 'Read(*)', 'Edit(*)', 'Write(*)',
    'Grep(*)', 'Glob(*)', 'Agent(*)',
    'WebFetch(*)', 'WebSearch(*)'
}
if 'permissions' in settings and 'allow' in settings['permissions']:
    original_len = len(settings['permissions']['allow'])
    settings['permissions']['allow'] = [
        p for p in settings['permissions']['allow']
        if p not in auto_allow
    ]
    if len(settings['permissions']['allow']) < original_len:
        removed_perms = True
        print('Removed auto-allow permissions.')
    else:
        print('No matching permissions found — skipping.')

    # Clean up empty structures
    if not settings['permissions']['allow']:
        del settings['permissions']['allow']
    if not settings['permissions']:
        del settings['permissions']

# Write back
with open(settings_file, 'w') as f:
    json.dump(settings, f, indent=2)
    f.write('\n')

if not removed_hook and not removed_perms:
    print('Nothing to remove.')
"

  # Clean up session caches
  CLEANED=$(find /tmp -name "pixel-approve-*.cache" -delete -print 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$CLEANED" -gt 0 ]]; then
    echo "Cleaned up $CLEANED session cache(s) from /tmp."
  fi

  echo ""
  echo "Uninstalled from: $SETTINGS_FILE"
  echo "Claude Code's default terminal prompts are now restored."

fi
