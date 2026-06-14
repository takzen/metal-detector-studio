"""Entry point: run the Metal Detector Studio backend.

    cd backend && uv run python main.py

Config via env: METAL_LAB_PROFILE (default spectral_g4), METAL_LAB_SERIAL_PORT
(e.g. COM5), METAL_LAB_HOST, METAL_LAB_PORT.
"""

import logging

import uvicorn

from app import config


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    uvicorn.run("app.server.app:app", host=config.HOST, port=config.PORT, log_level="info")


if __name__ == "__main__":
    main()
