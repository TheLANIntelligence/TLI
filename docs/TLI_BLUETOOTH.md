# Bluetooth devices in TLI

TLI uses the **host computer's Bluetooth radio**. A phone or browser connected
to TLI does not supply its Bluetooth hardware. Built-in Bluetooth is enough;
a compatible USB Bluetooth adapter is needed only when the host lacks it.

This first implementation targets **Windows 11, build 22000 or newer**, with
Python 3.10 or newer and the optional Bleak 3.0.2 package. It adds explicit nearby
device discovery and an **experimental Govee H6125 on/off profile**. It is not
universal Bluetooth support: headphones, keyboards, arbitrary GATT services,
other Govee models, colour, brightness, toggle and autonomous routines are not
enabled by this profile. General Ask TLI remains available without Bluetooth.

## Prepare the host

Use the Python environment that runs this TLI installation. Stop that host before
changing its dependencies, preserve its saved data, then install the optional
requirements. From a source checkout using the documented environment:

```powershell
.\backend\.venv\Scripts\python.exe -m pip install -r backend/requirements-bluetooth.txt
```

An installed package may use a different prepared interpreter; use that exact
environment rather than an unrelated system Python. Start the prepared host
normally after installation. TLI does not install this package, enable a radio,
pair Windows devices or start scanning on its own. The software-availability
message does not prove a working radio. A disabled/missing radio, Windows
permissions, range or another app holding the light can prevent a connection.

Bleak's current [package requirements](https://pypi.org/project/bleak/3.0.2/)
specify Windows 11 and Python 3.10+. Windows 10 and other operating systems are
outside this first TLI integration. The pinned optional dependency is not a
complete transitive lock or proof of clean-install acceptance.

## Add the H6125 deliberately

1. Unlock TLI and open **Smart home → Experimental · Bluetooth lights** below
   the optional Home Assistant connection. This section is collapsed by default.
2. Choose **Scan Bluetooth devices**. This starts one bounded discovery on the host.
   Opening the panel or unlocking TLI does not scan or connect to lights.
3. Select your light and the **Govee H6125** integration from the model list,
   check the model printed on the device/controller, and confirm it matches.
   Advertised names are hints; they are not authenticated
   identities or evidence that every Govee product is supported.
4. Choose a unique household name and optionally a room, then add the device.
   Enrollment connects to that selected address to check the expected GATT
   interface and saves through the existing HomePower store. It does not send
   an on/off command or enroll a different device if connection fails.
5. Use **Check state**, **On** or **Off** explicitly. The same configured name
   is available to the existing named-device conversation flow, such as
   “Turn on desk light.” Ambiguous names require clarification.
6. **Forget device** removes that saved TLI entry after confirmation. It does
   not switch the light, unpair Windows or erase device settings. An uncertain
   save/removal requires a fresh saved-inventory read before another attempt.

Only the selected address and fixed supported profile are used. TLI does not
accept arbitrary characteristic UUIDs or user/model-generated Bluetooth packets.
Saved devices survive locking; nearby discovery results and private browser
views are cleared. Unlocking never repeats a scan, enrollment or command.

## Different brands and connection methods

TLI's household system is intended for mixed-brand homes. A transport such as
Bluetooth provides the connection; a model integration defines the device's
commands and how to read its state. A discovered name is insufficient to select
that protocol safely. Different brands, and sometimes different models from the
same brand, need different integrations.

Bluetooth setup reads a code-owned catalog rather than assuming every light is
a Govee. It lists the available brand/model profiles and their validation level,
requires an explicit selection and label confirmation, and exposes only that
profile's declared controls. Nearby devices without a matching integration may
appear in discovery; do not choose another brand to force support. The selected
integration must also validate the device's interface before enrollment. This
interface check is not authenticated proof of the device's manufacturer.
Only the experimental H6125 profile is shipped today; the generic catalog and
synthetic second-brand tests do not add physical support for a second brand.

Other connection paths already exist in source. This table describes the code,
not a certification of every product from the named brand:

| Path | Current source | Acceptance still required |
| --- | --- | --- |
| Direct Bluetooth | Experimental H6125 profile; shared discovery, catalog and enrollment | Actual radio, firmware, power control and reported state |
| Philips Hue | `drivers/hue.py` uses a configured Hue Bridge REST API | Exact bridge/model setup, errors, permissions and physical results; no direct Hue Bluetooth profile |
| WLED / Yeelight | Separate local REST / TCP adapters | Matching firmware/protocol, setup and reliable outcomes |
| Govee LAN | Separate configured UDP adapter | A matching LAN-capable model; not a substitute for the H6125 Bluetooth profile |
| TP-Link Kasa / Tuya | Legacy Kasa TCP and optional Tuya Local adapters | Exact model/protocol and credential setup; neither is a generic BLE integration |
| Home Assistant | Existing temporary connection for individually reviewed light/switch reads and On/Off actions | A separately configured Home Assistant integration and physical acceptance |

The [Home Assistant guide](TLI_HOME_ASSISTANT_BRIDGE.md) describes that separate
connection. It does not automatically add those devices to named chat, persist
their credentials or turn Bluetooth discovery into universal setup.

To add another direct Bluetooth brand, implement a fixed profile and checked
driver, register its catalog entry, and test enrollment, supported controls,
fresh/unknown state, permission loss and uncertain commands. Then record an
actual model/firmware trial before changing its validation label. Catalog
entries cannot supply arbitrary packets, import external drivers or turn a
saved device into another model. Existing H6125 records need no migration.

## What an outcome means

**Sent** means the Bluetooth write completed; it is not an acknowledgement that
the lamp changed. **Reported on/off** requires a separate valid status frame.
No response, invalid packets or timeouts leave state **unknown**, never OFF.
The initial H6125 protocol profile needs physical acceptance on your device;
a reported state is still separate from observing the actual light.

After an uncertain write, check the device before deciding on another command.
TLI does not retry a command automatically or switch to another address, driver
or cloud account. Its existing request cache prevents short-lived duplicate
invocations; it is not durable deduplication across restarts or deliberate new
commands. Access loss stops further work and disclosure, while cleanup still
disconnects the temporary Bluetooth connection.
If native cleanup cannot be confirmed, further Bluetooth work is blocked in
that host process. Preserve the outcome, stop the host and review the device
before restarting; a restart does not prove an uncertain command failed.

## Protocol evidence and acceptance limits

The implementation was prepared from public implementer evidence, checked
2026-10-16. The [H6125-specific protocol notes](https://gist.github.com/allepet/23256335b64ab549dc72f66449bc3217)
describe colour/brightness framing. The broader
[Govee BLE implementation](https://github.com/Jaano/govee_lights/blob/master/custom_components/govee_lights/govee_ble.py)
and its [protocol notes](https://github.com/Jaano/govee_lights/blob/master/GOVEE_BLE.md)
provide the family on/off and power-query format. H6125 power readback has not
been verified against the founder's strip. This is why the profile remains
experimental even after synthetic tests pass.

The TLI transport uses one lazy persistent asyncio loop, consistent with
[Bleak's lifecycle guidance](https://bleak.readthedocs.io/en/stable/troubleshooting.html).
Discovery, connection, characteristic validation, writes and responses retain
captured access checks. Tests replace the Bluetooth transport; they do not
demonstrate actual radio, range, firmware or Windows behavior.

Before claiming household readiness, record the actual Windows build, Bluetooth
adapter/driver, Bleak environment, H6125 firmware, deliberate enrollment, on/off,
unknown-state behavior, locking during each operation, disconnects and restart.
Observe the physical light and later named-device recall independently. See the
[pilot sheet](TLI_WINDOWS_HOUSEHOLD_PILOT.md) and [audit](TLI_AUDIT.md).
