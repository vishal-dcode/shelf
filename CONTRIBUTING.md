# Contributing to Shelf

Thanks for helping. Bug reports, fixes and small improvements are all welcome.

## Before you start

- **Bugs:** open an issue with the steps to reproduce it, your browser and version, and what you expected.
- **New features:** open an issue first, so we can agree it fits before you spend time on it.
- **Security problems:** don't open a public issue. See [SECURITY.md](SECURITY.md).

## Making a change

1. Fork the repository and create a branch.
2. Make your change. Keep it focused: one fix or feature per pull request.
3. Run `npm test`. Add a test in `tests/` when you change behaviour in `lib/`.
4. Load the extension unpacked (see the README) and try your change in Chrome or Firefox.
5. Open a pull request saying what changed and why.

## Ground rules

- **No tracking of any kind:** no analytics, telemetry or remote logging. Pull requests that add any will be closed.
- **No new network addresses.** The extension talks only to the sign-in service and Shelf's API.
- **No HTML from strings.** Build the page with `h()` from `lib/ui.js`; never use `innerHTML` or `eval`.
- **No new dependencies.** The extension has none, and that keeps it easy to review.
- **Colours** go in `styles/theme.css` only.
- **Every action works by keyboard,** and every drag has a keyboard alternative.

By contributing, you agree that your contribution is licensed under the same licence as the project (GPL-3.0-or-later).
