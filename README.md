# SunFire Plugin

A Kizen CRM plugin that integrates with [SunFire](https://www.sunfireinc.com/quoting-enrollment/) to let agents quote and enroll Medicare Advantage (MAPD) plans directly from a contact record.

## What it does

The plugin adds a **Start Quoting in SunFire** action to contact records. When triggered, it:

- Looks up the contact's saved SunFire sessions from the last 90 days and lets the user resume one or start fresh.
- Syncs the contact's providers, pharmacies, and drugs from Kizen into a new SunFire session.
- Authenticates with SunFire using the agent's CRM connect code (prompting to collect and save one if it's missing).
- Opens a SunFire quoting/enrollment window pre-loaded with the contact's applicant info, plans, and (when available) ZIP/county for plan search.

## Configuration

Each install of the plugin requires:

| Field | Description |
| --- | --- |
| `partner_id` | SunFire partner ID for the business |
| `partner_app_id` | SunFire partner app ID (defaults to `sunfire` if not set) |

The business's `sunfire_env` entitlement determines which SunFire environment (`qa` or `prod`) the plugin talks to; it defaults to `prod`.

## Project structure

```
kizen.json                        # Plugin manifest: metadata, environments, and SunFire service/auth config
sunfire/
  thumbnail.png                   # Plugin thumbnail shown in the Kizen app marketplace
  actions/
    startQuoting/
      config.json                 # Action metadata (name, target object)
      script.js                   # Action implementation
releaseNotes/sunfire/             # Per-version release notes shown in the Kizen app
```

## Release notes

See [releaseNotes/sunfire](releaseNotes/sunfire) for the changelog.
