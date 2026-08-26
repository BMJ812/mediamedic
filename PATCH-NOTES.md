# MediaMedic v0.4.4 — Discord Scope Validation

This patch builds on v0.4.3 and fixes the Discord configuration failure that allowed a channel ID to be saved as a repair-role ID while an old channel lock remained active.

## What v0.4.4 prevents

- Rejects malformed Discord IDs before they are written to `settings.json`.
- Rejects `Allowed Channel ID` when it is identical to `Repair Role ID`.
- Rejects `Allowed Channel ID` when it is identical to `Admin Role ID`.
- Before saving through the Web UI, authenticates the bot token and verifies that the configured Application / Client ID matches that bot.
- Verifies the configured Guild ID is accessible to the bot.
- Verifies Repair Role ID and Admin Role ID against the guild's actual Discord role list.
- Verifies Allowed Channel ID by retrieving the actual Discord channel and confirming that it belongs to the configured guild.
- Rejects category IDs as the allowed command destination.
- `Test connections` now reports the resolved channel name and role name instead of only showing raw IDs.
- Updates the Web UI field hints so role IDs and channel IDs are harder to confuse.

## Why this was needed

A valid Discord snowflake is just a number. MediaMedic v0.4.3 and earlier treated role IDs and channel IDs as untyped strings. That made this invalid configuration possible:

- Repair Role ID = a channel ID
- Allowed Channel ID = an old channel ID

The bot then correctly enforced the old channel lock, while Discord autocomplete only displayed `No options match your search`, which made the underlying configuration mistake difficult to diagnose.

## Files replaced

- `src/web.js`
- `src/settings.js`
- `package.json`

The installer also applies small copy/label improvements to `public/index.html` and backs up every modified file before changing it.

## Validation performed

- `node --check` on the patched JavaScript files.
- Unit check that a channel/role collision is rejected.
- Unit check that a malformed Discord snowflake is rejected.
- `npm run check` and `git diff --check` are run by the installer before commit/tag/push.
