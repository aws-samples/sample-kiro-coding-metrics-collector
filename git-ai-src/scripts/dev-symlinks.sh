#!/bin/bash

set -euo pipefail

# Parse arguments
BUILD_TYPE="debug"
if [[ "$#" -gt 0 && "$1" == "--release" ]]; then
    BUILD_TYPE="release"
fi

# Fixed location for gitwrap symlinks
GITWRAP_DIR="$HOME/.git-ai-local-dev/gitwrap/bin"
PROJECT_DIR="$(pwd)"
PATH_EXPORT_LINE="export PATH=\"$GITWRAP_DIR:\$PATH\""
PATH_MARKER="# git-ai local dev"

# Determine which shell profile to use
detect_shell_profile() {
    local shell_name
    shell_name=$(basename "$SHELL")

    case "$shell_name" in
        zsh)
            # Prefer .zshrc for interactive shells, fall back to .zprofile
            if [[ -f "$HOME/.zshrc" ]]; then
                echo "$HOME/.zshrc"
            elif [[ -f "$HOME/.zprofile" ]]; then
                echo "$HOME/.zprofile"
            else
                echo "$HOME/.zshrc"
            fi
            ;;
        bash)
            # On macOS, prefer .bash_profile; on Linux, prefer .bashrc
            if [[ "$(uname)" == "Darwin" ]]; then
                if [[ -f "$HOME/.bash_profile" ]]; then
                    echo "$HOME/.bash_profile"
                elif [[ -f "$HOME/.bashrc" ]]; then
                    echo "$HOME/.bashrc"
                else
                    echo "$HOME/.bash_profile"
                fi
            else
                if [[ -f "$HOME/.bashrc" ]]; then
                    echo "$HOME/.bashrc"
                elif [[ -f "$HOME/.bash_profile" ]]; then
                    echo "$HOME/.bash_profile"
                else
                    echo "$HOME/.bashrc"
                fi
            fi
            ;;
        *)
            # Default to .profile for unknown shells
            echo "$HOME/.profile"
            ;;
    esac
}

SHELL_PROFILE=$(detect_shell_profile)

# Create gitwrap directory
mkdir -p "$GITWRAP_DIR"

echo "Creating symlinks in $GITWRAP_DIR pointing to $PROJECT_DIR/target/$BUILD_TYPE"
ln -sf "$PROJECT_DIR/target/$BUILD_TYPE/git-ai" "$GITWRAP_DIR/git"
ln -sf "$PROJECT_DIR/target/$BUILD_TYPE/git-ai" "$GITWRAP_DIR/git-ai"

echo "Installing hooks..."
if ! "$GITWRAP_DIR/git-ai" install-hooks; then
    echo "Error: Failed to install hooks" >&2
    exit 1
fi

# Check and update shell profile
PROFILE_CHANGED=false

# Create profile if it doesn't exist
if [[ ! -f "$SHELL_PROFILE" ]]; then
    touch "$SHELL_PROFILE"
fi

# Check if any git-ai local dev PATH entry exists
if grep -q "git-ai-local-dev/gitwrap/bin" "$SHELL_PROFILE" || grep -q "target/gitwrap/bin" "$SHELL_PROFILE"; then
    # Extract the current PATH line (either old or new format)
    CURRENT_LINE=$(grep -E "(git-ai-local-dev/gitwrap/bin|target/gitwrap/bin)" "$SHELL_PROFILE" | head -n 1)

    if [[ "$CURRENT_LINE" == "$PATH_EXPORT_LINE" ]]; then
        echo ""
        echo "Shell profile ($SHELL_PROFILE) already has the correct PATH configuration."
        echo "No changes required."
    else
        echo ""
        echo "Updating existing git-ai PATH entry in $SHELL_PROFILE..."

        # Remove old marker comment if present
        sed -i.bak '/# git-ai local dev/d' "$SHELL_PROFILE"
        # Remove old PATH lines (both old and new format)
        sed -i.bak '/git-ai-local-dev\/gitwrap\/bin/d' "$SHELL_PROFILE"
        sed -i.bak '/target\/gitwrap\/bin/d' "$SHELL_PROFILE"

        # Add new configuration
        echo "" >> "$SHELL_PROFILE"
        echo "$PATH_MARKER" >> "$SHELL_PROFILE"
        echo "$PATH_EXPORT_LINE" >> "$SHELL_PROFILE"

        # Clean up backup files
        rm -f "$SHELL_PROFILE.bak"

        PROFILE_CHANGED=true
    fi
else
    echo ""
    echo "Adding git-ai PATH configuration to $SHELL_PROFILE..."

    echo "" >> "$SHELL_PROFILE"
    echo "$PATH_MARKER" >> "$SHELL_PROFILE"
    echo "$PATH_EXPORT_LINE" >> "$SHELL_PROFILE"

    PROFILE_CHANGED=true
fi

echo ""
if [[ "$PROFILE_CHANGED" == true ]]; then
    echo "=========================================="
    echo "Shell profile has been updated!"
    echo ""
    echo "Please restart all your open shells or run:"
    echo "  source $SHELL_PROFILE"
    echo ""
    echo "Make sure to remove any git aliases or artifacts from running 'install.sh'"
    echo "=========================================="
else
    echo "Symlinks updated successfully. Your shell is already configured correctly."
fi
