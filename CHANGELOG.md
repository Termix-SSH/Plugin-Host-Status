# Changelog

## 1.1.0

### Added

- Check whether a host is online through Termix actions, with an Online tile on the host page and in the All hosts table
- Permission Check host status

### Changed

- Needs Termix 26.11.1 or newer

## 1.0.0

### Added

- The online or offline dot in the host list now comes from this plugin
- Checks use the host's port and never log in, so devices with two factor logins get no prompt
- Hosts behind jump hosts are checked through the chain
- An open session or a working login counts as online
- Check interval setting for everyone, with a different interval per host
