# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec for StateVO.

Build with (from the project root):
    pyinstaller packaging/statevo.spec

Note: pedalboard, sounddevice (PortAudio), and PySide6 all ship native
binaries. If the built executable fails to find them at runtime on your
platform, add the missing shared libraries to `binaries=[...]` below —
PyInstaller's hooks usually catch these automatically, but audio
libraries are a common exception.
"""

block_cipher = None

a = Analysis(
    ['../statevo/app.py'],
    pathex=['..'],
    binaries=[],
    datas=[
        ('../statevo/assets', 'statevo/assets'),
    ],
    hiddenimports=['soundfile', 'sounddevice'],
    hookspath=[],
    runtime_hooks=[],
    excludes=[],
    cipher=block_cipher,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz, a.scripts, a.binaries, a.zipfiles, a.datas,
    name='StateVO',
    debug=False,
    strip=False,
    upx=True,
    console=False,
)
