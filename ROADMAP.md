# Roadmap

Ideas we've looked into but aren't doing yet, with what we learned.

## Native app (Capacitor)

The web app hits limits a native wrapper would lift:

- **Listening with the screen off.** Browser speech stops when Chrome is backgrounded. Native Android text-to-speech, kept alive by a foreground service with a media notification, wouldn't.
- **Likes and comments.** Writes through the Worker need Patreon's CSRF signature, and may meet Cloudflare bot checks aimed at datacenter IPs. A native app can call Patreon directly from the phone (no CORS), possibly with no Worker at all.
- **Setup.** Sign in to Patreon inside the app and pick up the session, instead of copying `session_id` from a computer.
- **System bars.** Separate nav-bar colours for light and dark mode, and hiding only the nav bar while reading. Today Chrome paints the installed app's nav bar with the manifest's single `background_color`.

Cost for personal use is $0 (Capacitor, Android Studio, on-device voices are free). Money only comes in for Google Play ($25 one-time) or iPhone ($99/year Apple Developer Program, plus a Mac).

A Chrome-based wrapper (Bubblewrap / Trusted Web Activity) was ruled out: it only fixes the nav-bar colours.

## Distribution, if others want it

Only once the app no longer routes through a personal Cloudflare Worker. Until then, it isn't distributed.

- **GitHub releases + [Obtainium](https://obtainium.imranr.dev/):** attach the APK to a release; Obtainium on the phone checks the repo and installs updates. Free, no store review.
- **F-Droid / IzzyOnDroid:** possible later (open source). F-Droid builds from source and would label the app for depending on a non-free network service.
- **Android developer verification:** apps installed outside Play must come from a verified developer (enforced in some countries from 30 September 2026, elsewhere later). The free hobbyist account allows up to 20 devices; a full verified account ($25 one-time, government ID, package name and signing key registered) has no device limit. Installing over USB with `adb` remains open.

A public version could also show Patreon there's demand for a better reading experience in its own app.
