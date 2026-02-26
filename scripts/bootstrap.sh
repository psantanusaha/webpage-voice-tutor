#!/bin/sh
set -e

echo "Installing dependencies..."
npm install

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example"
else
  echo ".env already exists, leaving it unchanged"
fi

echo "Bootstrap complete. Update VOCALBRIDGE_API_KEY in .env and run: npm start"
