#!/bin/bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PIXEL_AGENTS_DIR=$(dirname "$SCRIPT_DIR")
HOOK_SCRIPT="$PIXEL_AGENTS_DIR/scripts/approve-hook.sh"

# Verify approve-hook.sh exists
if [ ! -f "$HOOK_SCRIPT" ]; then
  echo "Error: approve-hook.sh not found at $HOOK_SCRIPT"
  exit 1
fi

# Make approve-hook.sh executable if not already
if [ ! -x "$HOOK_SCRIPT" ]; then
  chmod +x "$HOOK_SCRIPT"
  echo "Made $HOOK_SCRIPT executable."
fi

# Ask user for install scope
echo ""
echo "Where would you like to install the pixel-agents approval hook?"
echo "  1) Globally (~/.claude/settings.json)"
echo "  2) For a specific project"
echo ""
read -rp "Choice [1/2]: " choice

if [ "$choice" = "2" ]; then
  read -rp "Enter the project directory path: " PROJECT_DIR
  # Expand ~ if present
  PROJECT_DIR="${PROJECT_DIR/#\~/$HOME}"
  if [ ! -d "$PROJECT_DIR" ]; then
    echo "Error: Directory $PROJECT_DIR does not exist."
    exit 1
  fi
  SETTINGS_DIR="$PROJECT_DIR/.claude"
  SETTINGS_FILE="$SETTINGS_DIR/settings.json"
else
  SETTINGS_DIR="$HOME/.claude"
  SETTINGS_FILE="$SETTINGS_DIR/settings.json"
fi

# Create .claude directory if needed
if [ ! -d "$SETTINGS_DIR" ]; then
  mkdir -p "$SETTINGS_DIR"
  echo "Created $SETTINGS_DIR"
fi

# Merge hook into settings.json using python3
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

# Ensure hooks.PreToolUse exists
if 'hooks' not in settings:
    settings['hooks'] = {}
if 'PreToolUse' not in settings['hooks']:
    settings['hooks']['PreToolUse'] = []

# Check for duplicate
hook_entry = {'type': 'command', 'command': hook_command}
already_exists = any(
    h.get('type') == 'command' and h.get('command') == hook_command
    for h in settings['hooks']['PreToolUse']
)

if already_exists:
    print('Hook already configured in ' + settings_file + ' — skipping.')
    sys.exit(0)

# Add the hook
settings['hooks']['PreToolUse'].append(hook_entry)

# Write back
with open(settings_file, 'w') as f:
    json.dump(settings, f, indent=2)
    f.write('\n')

print('Hook added successfully.')
"

echo ""
echo "Updated: $SETTINGS_FILE"
echo ""
echo "Reminder: The pixel-agents server must be running at http://localhost:3456"
echo "Start it with: cd $PIXEL_AGENTS_DIR && npm run dev"
