FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS client-build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY client/ client/
COPY data/ data/
COPY yaml/test-data/ yaml/test-data/
COPY shared/ shared/
COPY scripts/build-standalone.mjs scripts/third-party-notices.mjs scripts/help-content.mjs scripts/
COPY docs/ docs/
COPY README.md LICENSE ./
RUN npm run build

FROM python:3.14-slim-bookworm@sha256:9ab8d9c8514b44f90cf0029dd42fdd7e9e211e639c8b995304cc04568dee900f AS python-base
COPY --from=ghcr.io/astral-sh/uv:0.12.13@sha256:b485bd65cc2cf1c9a93b3554012c9c3778cf7b1b5fd3d3096ce9e1226c97e1e6 /uv /usr/local/bin/uv
WORKDIR /app
ENV UV_PYTHON_DOWNLOADS=never UV_LINK_MODE=copy PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY pyproject.toml uv.lock LICENSE ./
RUN uv sync --locked --no-dev --no-install-project

FROM python-base AS verification
COPY --from=client-build /usr/local/bin/node /usr/local/bin/node
COPY --from=client-build /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm
RUN ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
RUN uv sync --locked --no-install-project
RUN npx playwright install --with-deps chromium firefox
RUN apt-get update
RUN apt-get install -y --no-install-recommends libegl1 libgl1 xauth xvfb
COPY --from=client-build /app/dist/ dist/
COPY client/ client/
COPY data/ data/
COPY yaml/test-data/ yaml/test-data/
COPY shared/ shared/
COPY docs/licenses/ docs/licenses/
COPY docs/*.md docs/
COPY docs/releases/ docs/releases/
COPY .github/workflows/ .github/workflows/
COPY config/github-protection.json config/github-protection.json
COPY README.md Dockerfile .dockerignore ./
COPY server/ server/
COPY scripts/ scripts/
COPY tests/ tests/
COPY playwright.config.mjs playwright.matrix.config.mjs playwright.demo.config.mjs ./
CMD ["uv", "run", "--locked", "pytest", "tests/server", "-q"]

FROM python-base AS runtime
COPY --from=client-build /app/dist/ dist/
COPY --from=client-build /app/data/ data/
COPY --from=client-build /app/yaml/test-data/ yaml/test-data/
COPY --from=client-build /app/client/assets/ client/assets/
COPY shared/ shared/
COPY server/ server/
COPY scripts/ scripts/
RUN groupadd --gid 10001 timeline
RUN useradd --uid 10001 --gid timeline --no-create-home --home-dir /tmp --shell /usr/sbin/nologin timeline
RUN install -d -o timeline -g timeline -m 0770 /var/lib/openbexi
ENV OPENBEXI_DATA_ROOT=/var/lib/openbexi HOME=/tmp
USER 10001:10001
EXPOSE 8765
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=3 CMD ["/app/.venv/bin/python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8765/health/ready',timeout=3).read()"]
CMD ["/app/.venv/bin/python", "-m", "uvicorn", "server.app.main:app", "--host", "0.0.0.0", "--port", "8765", "--workers", "1"]
