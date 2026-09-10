"""
Core domain logic: project data model, audio engine, editing, DSP, export.

Rule for this package: NO Qt imports. Keeping this layer UI-agnostic is
what makes it testable headlessly (see tests/) and reusable later from
something other than the desktop app — a CLI batch-exporter, or an AI
post-processing service, for instance.
"""
