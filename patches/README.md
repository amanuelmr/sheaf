# Patched dependencies

Patches are a liability: they rot silently when the upstream package moves. Each one
here records what it does, why, and what should make it go away.

## `expo-modules-jsi@57.0.5`

**Symptom.** `expo run:ios` fails during _Build ExpoModulesJSI xcframework_:

```
RuntimeScheduler.h:61:26: error: 'RuntimeScheduler' cannot be annotated with either
SWIFT_RETURNS_RETAINED or SWIFT_RETURNS_UNRETAINED because it is not returning a
SWIFT_SHARED_REFERENCE type
```

**Cause.** Two _constructors_ of `expo::RuntimeScheduler` are annotated
`SWIFT_RETURNS_RETAINED`. A constructor has no return type, so Swift's C++ importer
rejects the annotation. Older toolchains ignored it; Swift 6.2 (Xcode 26) diagnoses
it. Nothing about this project triggers it — any SDK 57 app hits it on a current
Xcode, and 57.0.5 is the latest published version.

**Fix.** Delete the annotation from the two constructors. Two lines.

**Why that is safe.** The annotation was redundant, which was verified rather than
assumed. Swift already imports constructors of a `SWIFT_SHARED_REFERENCE` type as
`+1`, so removing it changes nothing about ownership. A minimal reproduction with
instrumented `retain`/`release` was built and run:

```
101 constructions from Swift -> 101 releases, 101 deletes, 0 spurious retains
```

Balanced: no leak, and no over-release. The same experiment also confirmed the
annotation is only rejected on constructors — a `static` factory returning the same
type keeps it happily, so this is not a general problem with the type's design.

**Removal criteria.** Delete this patch when `expo-modules-jsi` ships a version whose
`RuntimeScheduler.h` no longer annotates its constructors. Worth reporting upstream;
it affects every SDK 57 iOS build on Xcode 26.
