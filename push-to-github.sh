#!/bin/bash
# Run this once from Terminal to push nafsi-site to GitHub
# Double-click or run: bash push-to-github.sh

set -e

REPO_URL="https://github.com/ahmashadani/nafsi.git"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "📂 Working in: $SCRIPT_DIR"
cd "$SCRIPT_DIR"

# Remove broken .git if exists, start fresh
if [ -d ".git" ]; then
  echo "🔄 Removing old .git folder..."
  rm -rf .git
fi

echo "🔧 Initializing git..."
git init -b main
git config user.email "sara65adham@gmail.com"
git config user.name "Sara Adham"

echo "➕ Staging all files..."
git add -A

echo "💬 Creating commit..."
git commit -m "Initial commit — Nafsi Clinic site"

echo "🔗 Setting remote to GitHub..."
git remote add origin "$REPO_URL"

echo "🚀 Pushing to GitHub (you may be asked to log in)..."
git push -u origin main

echo ""
echo "✅ Done! Your site is now on GitHub at:"
echo "   $REPO_URL"
echo ""
echo "Netlify will auto-deploy on every future push."
