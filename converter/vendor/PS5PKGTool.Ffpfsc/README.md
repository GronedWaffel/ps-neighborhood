# PS5PKGTool.Ffpfsc

Managed, separately testable codecs used by PS5 PKG Tool:

- `ExfatImage` plans and streams a standards-based exFAT image from a loose directory without a temporary disk image.
- `AmprIndex` builds and validates AMPRIDX3 lookup data. `ExfatImage` adds it virtually when the dump contains `fakelib/libSceAmpr.sprx`; it never writes into the source directory.
- `PfscCodec` encodes, inspects, randomly reads, and decodes 64 KiB zlib/raw PFSC blocks with strict offset validation.
- `FfpfscImage` creates an unsigned PS5 PFS single-file wrapper, inspects its inode/directory/FPT layout, extracts its payload, and performs full decode/SHA-256 verification.

Primary entry points:

```csharp
await FfpfscImage.CreateFromDirectoryAsync(dumpFolder, outputFfpfsc);
await FfpfscImage.CreateFromImageAsync(sourceExfatOrFfpkg, outputFfpfsc);
FfpfscVerificationResult result = await FfpfscImage.VerifyAsync(outputFfpfsc);
await FfpfscImage.ExtractAsync(outputFfpfsc, extractedImage);
```

Writers use a unique temporary sibling and publish the destination only after validation. Existing files are not replaced unless `FfpfscBuildOptions.OverwriteExisting` is explicitly enabled. Retail encrypted/signed PFS construction is outside this library; the generated format is the unsigned wrapper used by jailbreak-side FFPFSC mounting workflows.

The native exFAT serializer mirrors MkPFS deterministic layout details, including its compact Microsoft up-case table, volume serial, fixed exFAT timestamps, directory allocation, ignored metadata names, and AMPRIDX3 generation. Golden interoperability tests require byte-identical raw exFAT output and byte-identical level-9 FFPFSC output when both writers receive the same PFS build timestamp. PFS timestamps normally use the current UTC second, so independently started builds can have different whole-image hashes despite identical payload bytes.
