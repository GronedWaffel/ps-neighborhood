# Importing RAM captures into Ghidra

Export selected readable mappings or a bounded range from PS Neighbourhood. The resulting bundle contains raw segments, original virtual addresses, permissions, SHA-256 hashes, a manifest and `ImportPSNeighbourhood.java`.

In Ghidra Script Manager, add the bundle folder to the script directories and run `ImportPSNeighbourhood.java`. Select that bundle when prompted. Save the new program, then run Auto Analyze. A capture is not a reconstructed ELF/SELF; it contains only the requested memory, and live reads are sequential rather than atomic.

New bundles also support headless import:

```powershell
& '<Ghidra directory>\support\analyzeHeadless.bat' '<project directory>' PSNRAM -scriptPath '<bundle folder>' -preScript ImportPSNeighbourhood.java '<bundle folder>' -noanalysis
```

The importer saves a new `PSN_<bundle-id>` program. Existing programs are not overwritten. Run `analyzeHeadless` with `-process PSN_<bundle-id>` to analyze that saved program. Older bundles generated before this update support the interactive workflow but do not save automatically in headless mode.

## Repeatable validation

From a source checkout with Node.js and a Ghidra-compatible JDK available:

```powershell
.\scripts\verify-ghidra.ps1 -GhidraHome '<Ghidra directory>'
.\scripts\verify-ghidra.ps1 -GhidraHome '<Ghidra directory>' -Bundle '<existing bundle folder>'
```

The first command generates three synthetic regions with gaps, different permissions and addresses above 4 GiB. The second validates the source hashes and regenerates an importer from an existing capture without changing the original bundle. Both execute the actual generated importer, inspect the persisted program, reopen it, run analysis and verify every captured byte by SHA-256 plus addresses, lengths, permissions, region count and total mapped bytes.

Each run creates its own project and logs under ignored `artifacts/ghidra-validation/`. Captured memory and projects must remain private.

Validated on 2026-09-29 with Ghidra 12.1.3 and JDK 26.0.2.1: a real 65,536-byte PS5 capture and a 12,288-byte synthetic capture both passed import, persistence, reopen, analysis and verification. This establishes the tested importer behavior, not automatic reconstruction of every game's functions, symbols or relocated pointers.
