# Security Policy

PI-Harbor Desktop is an early-preview, local-first desktop application and an
independent fork of [PI-Desktop](https://github.com/vastsa/PI-Desktop). Security
reports about this fork are handled here; please do not send them upstream.

## Supported versions

Security fixes are provided for the latest release published on this
repository's releases page. Older releases and development builds may not
receive fixes.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
pull requests, or discussions.**

Use GitHub's private vulnerability reporting for this repository:

<https://gitlab.jjkets.top/jjkets/pi-harbor/-/issues/new?issue[confidential]=true>

If that is unavailable, send a private mail to **a1204219221@163.com** with the
subject:

```text
[PI-Harbor Desktop Security] <short description>
```

Please include as much of the following as you can:

- A clear description of the vulnerability and its security impact.
- The affected version, operating system, and installation type.
- Reproduction steps or a minimal proof of concept.
- The affected component, feature, configuration, or extension boundary.
- Relevant logs, screenshots, or stack traces.

Remove API keys, access tokens, passwords, private source code, personal data,
and other sensitive information before sending a report. Do not test against
other users, access data that does not belong to you, or perform destructive
actions. This fork has no bug bounty program.

## Scope notes for this fork

- The plugin catalog is a static file in this repository. Report a malicious or
  tampered catalog entry here; report vulnerabilities in the upstream plugin
  centre or in PI-Desktop itself to the upstream project.
- macOS releases are signed with the fork owner's certificate; verify the
  published Developer ID before installing.
