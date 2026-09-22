"""Publish this Mac as `flybrain.local` so the lens never hard-codes an IP (DHCP moves it).
Adapted from an earlier project of ours."""

from __future__ import annotations

import logging
import os
import socket

logger = logging.getLogger("flybrain.mdns")
NAME = os.getenv("FLYBRAIN_MDNS_NAME", "flybrain")


def lan_ip() -> str:
    """Address of the interface that routes outward (no packet is sent)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return ""
    finally:
        s.close()


class Responder:
    def __init__(self, ip: str, port: int):
        self.ip, self.port = ip, port
        self._zc = self._info = None

    def start(self) -> bool:
        try:
            from zeroconf import ServiceInfo, Zeroconf
        except ImportError:
            logger.info("zeroconf not installed — lens must use the IP")
            return False
        if not self.ip:
            return False
        try:
            self._zc = Zeroconf()
            self._info = ServiceInfo(
                "_flybrain._tcp.local.",
                "FlyBrain._flybrain._tcp.local.",
                addresses=[socket.inet_aton(self.ip)],
                port=self.port,
                server=f"{NAME}.local.",  # creates the A record the lens resolves
                properties={"role": "fly-brain"},
            )
            self._zc.register_service(self._info)
            logger.info(f"published {NAME}.local -> {self.ip} (ws://{NAME}.local:{self.port})")
            return True
        except Exception as e:  # never fatal: the IP still works
            logger.warning(f"could not publish {NAME}.local: {e!r}")
            self._zc = None
            return False

    def stop(self):
        try:
            if self._zc and self._info:
                self._zc.unregister_service(self._info)
            if self._zc:
                self._zc.close()
        finally:
            self._zc = self._info = None
