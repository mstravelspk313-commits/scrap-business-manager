# Scrap Business Manager

A lightweight production-ready starter for managing scrap purchases, sales, payments, stock by item type, and party ledgers.

## Features
- Authentication with email/password.
- Auto-create parties when entering a new name.
- Soft delete + restore transactions.
- Capital tracking with opening balance + transactions.
- Stock tracking for compressor scrap categories.
- Separate party ledger views.

## Setup
```bash
npm install
npm start
```

Then open `http://localhost:3000`.

## Notes
- Data is stored in `data.sqlite3` in the project root.
- Adjust the `SESSION_SECRET` environment variable for production.
