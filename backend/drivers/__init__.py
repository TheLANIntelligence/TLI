from .base import DeviceDriver
from .shelly import ShellyDriver
from .hue import HueDriver
from .govee import GoveeDriver
from .wled import WledDriver
from .yeelight import YeelightDriver
from .sonoff import SonoffDriver
from .kasa import KasaDriver
from .tuya import TuyaDriver
from .generic_http import GenericHttpDriver

# Registry: vendor string → driver instance.
# NOTE: "shelly" is intentionally absent — ShellyDriver has a different constructor
# and is passed separately via shelly_driver. The legacy fallback in home_power.py
# handles Shelly execution.
DRIVER_REGISTRY: dict = {
    "hue":          HueDriver(),
    "govee":        GoveeDriver(),
    "wled":         WledDriver(),
    "yeelight":     YeelightDriver(),
    "sonoff":       SonoffDriver(),
    "kasa":         KasaDriver(),
    "tuya":         TuyaDriver(),
    "generic_http": GenericHttpDriver(),
}

__all__ = [
    "DeviceDriver",
    "ShellyDriver",
    "HueDriver",
    "GoveeDriver",
    "WledDriver",
    "YeelightDriver",
    "SonoffDriver",
    "KasaDriver",
    "TuyaDriver",
    "GenericHttpDriver",
    "DRIVER_REGISTRY",
]
