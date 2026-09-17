# MediaMedic

MediaMedic is a Discord-driven media repair assistant for **Radarr** and **Sonarr**, designed to run cleanly on **Unraid**.

Users with permission can report a bad movie, TV episode, or entire TV season from Discord. MediaMedic resolves the exact managed Radarr/Sonarr file, shows the user what it found, requires explicit confirmation, and then handles the repair through the *arr APIs rather than receiving direct delete access to your media filesystem.

## Features

- Discord `/repair movie`, `/repair episode`, and `/repair season` workflows
- Radarr and Sonarr autocomplete
- Exact managed-file verification before deletion
- Dry Run safety mode
- Guild, channel, and Discord role restrictions
- Conservative original-release correlation and blocklisting
- Automatic replacement search
- Discord repair-status tracking through download and import
- Restart-safe repair tracking stored in SQLite
- Built-in Web UI and first-run Discord application wizard
- No `/media` mount required

## Unraid installation

When installed through Community Applications, MediaMedic needs only:

- **Web UI port:** container port `8787`
- **Appdata:** `/config` mapped to `/mnt/user/appdata/mediamedic`

Then open the Web UI and use the setup wizard to configure Discord, Radarr, and Sonarr.

## Docker

```bash
docker run -d \
  --name mediamedic \
  --restart unless-stopped \
  -p 8787:8787 \
  -v /mnt/user/appdata/mediamedic:/config \
  ghcr.io/bmj812/mediamedic:latest
```

## Safety model

MediaMedic does not accept arbitrary filesystem paths from Discord. It operates on Radarr/Sonarr managed file IDs and re-verifies targets before destructive actions. Keep **Dry Run** enabled until your Discord, Radarr, and Sonarr connections have been tested.

## Support

Use GitHub Issues for bug reports and support. Never post Discord bot tokens or Radarr/Sonarr API keys in issues or logs.

## Contributing

Contributions are welcome. Fork the repository, make your changes on a branch, and open a pull request. Please describe what changed and why, and never include Discord tokens, API keys, or other secrets in commits or issues.

## License

Zlib
