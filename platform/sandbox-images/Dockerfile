# syntax=docker/dockerfile:1
FROM ghcr.io/astral-sh/uv:0.9.4@sha256:c4089b0085cf4d38e38d5cdaa5e57752c1878a6f41f2e3a3a234dc5f23942cb4 AS uv
FROM node:22-bookworm@sha256:0e5f906573693feaa1e21057ebdcfdb5bd5021f050b2dc7c9deceb629c7da2a8 AS workplace
ARG APT_MIRROR
ARG PIP_MIRROR
ARG NPM_MIRROR
ENV DEBIAN_FRONTEND=noninteractive MPLBACKEND=Agg
COPY apt-workplace.txt apt-office.txt requirements-workplace.txt /opt/oma/
COPY --from=uv /uv /opt/oma/uv
COPY python-entrypoint.sh /opt/oma/python-entrypoint.sh
RUN rm -f /etc/apt/sources.list /etc/apt/sources.list.d/* && \
    printf 'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/20261015T000000Z bookworm main\ndeb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/20261015T000000Z bookworm-security main\n' > /etc/apt/sources.list.d/oma.list && \
    if [ -n "$APT_MIRROR" ]; then printf 'deb %s bookworm main\n' "$APT_MIRROR" > /etc/apt/sources.list.d/oma.list; fi && \
    apt-get update && xargs -r apt-get install -y --no-install-recommends < /opt/oma/apt-workplace.txt && \
    rm -rf /var/lib/apt/lists/* && \
    python3 -m venv --system-site-packages /opt/venv && \
    if [ -n "$PIP_MIRROR" ]; then \
      printf '[global]\nindex-url = %s\n' "$PIP_MIRROR" > /etc/pip.conf; \
      mkdir -p /etc/uv; printf 'index-url = "%s"\n' "$PIP_MIRROR" > /etc/uv/uv.toml; \
    fi && \
    if [ -n "$NPM_MIRROR" ]; then printf 'registry=%s\n' "$NPM_MIRROR" > /etc/npmrc; fi && \
    /opt/venv/bin/python -m pip install --no-cache-dir pip==24.3.1 setuptools==75.6.0 wheel==0.45.1 && \
    /opt/venv/bin/python -m pip install --no-cache-dir --no-deps -r /opt/oma/requirements-workplace.txt && \
    /opt/venv/bin/python -m pip check && \
    chmod +x /opt/oma/python-entrypoint.sh && ln -s /opt/oma/uv /opt/venv/bin/uv && \
    for name in python python3 pip pip3 uv; do ln -sf /opt/oma/python-entrypoint.sh /usr/local/bin/$name; done && \
    fc-cache -f
COPY manifest.sh /opt/oma/manifest.sh
COPY selftest/render-ru.py selftest/sample-ru.txt /opt/oma/selftest/
RUN /bin/sh /opt/oma/manifest.sh > /etc/oma-manifest.tmp && \
    mkdir -p /etc/oma && mv /etc/oma-manifest.tmp /etc/oma/image-manifest.json
WORKDIR /workspace
ENTRYPOINT []
CMD ["/bin/bash"]

FROM workplace AS office
RUN apt-get update && xargs -r apt-get install -y --no-install-recommends < /opt/oma/apt-office.txt && \
    rm -rf /var/lib/apt/lists/* && fc-cache -f && \
    /bin/sh /opt/oma/manifest.sh > /etc/oma/image-manifest.json
