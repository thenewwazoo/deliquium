# Ramp direction — design decisions

Usage lives in the README. This records the choices and why, so they are not
relitigated later.

## Per-light, and only per-light

Direction is a required property of each light. The driving case is a single sunset
action that dims the recessed lights while bringing the chair lamp *up* — one
trigger, one switch, opposite directions.

An earlier version allowed a ramp-level default that individual lights could
override. That was dropped: a value that lives one level up and is silently
overridden somewhere else is something a reader has to hold in their head to
predict what a light will do. Writing `"direction"` on every light costs one line
each and makes every entry self-describing. There is nothing to inherit and
nothing to trace.

## Brightening from off turns the light on

An earlier draft proposed always skipping lights that report `0`, on the grounds
that switching a light on is more intrusive than adjusting one already lit. That was
wrong for the actual use case: "turn on the chair lamp at sunset" is the point.

Verified on hardware — a Caseta `PlugInDimmer` given `GoToDimmedLevel` from `0`
ramps up smoothly across the whole fade. It does not jump to a minimum on-level
first, so there is no visible pop and no need to pre-position the light.

Note this needs no code of its own. The general rule produces it: dimming cannot go
below `0`, so an off light is skipped; brightening can, so it is raised. Deleting
the `actual === 0` special case *added* the feature.

## `dim` / `brighten`, not `down` / `up`

In a config file sitting next to a switch accessory, `up` reads ambiguously — it
could plausibly refer to the switch rather than the brightness.

## No separate solar window for sunrise

Morning and evening civil twilight are the same length at every latitude and date
(`dawn -> sunrise` equals `sunset -> dusk` to the resolution suncalc reports). The
ramp consumes only the length, never the absolute times, so the existing hardcoded
computation already serves a sunrise ramp. `direction` decides which way; the
HomeKit automation decides when.
