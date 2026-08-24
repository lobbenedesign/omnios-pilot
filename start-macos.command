#!/bin/bash
cd "$(dirname "$0")"
echo "🖥️ Starting OmniOS-Pilot on http://localhost:3007..."
bun server.ts
