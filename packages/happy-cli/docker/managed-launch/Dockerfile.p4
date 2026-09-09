# specs/managed-cloud-byos P4 — tool executor 격리 실증 전용 이미지.
#
# §5.36 의 `Dockerfile` 은 동결이라 건드리지 않는다. helper 소스는
# `src/launcher/executorHelper.c` 하나뿐이고 여기로 복사본을 두지 않는다.
# 제품 API 번들(`stage/toolRuntime.cjs`)은 /tmp 스테이징에서 온다.
FROM node:22
RUN apt-get -qq update && apt-get -qq install -y gcc >/dev/null && rm -rf /var/lib/apt/lists/*
COPY src/launcher/executorHelper.c /build/executorHelper.c
RUN mkdir -p /usr/local/lib/saycode \
 && gcc -O2 -Wall -Wextra -Werror -o /usr/local/lib/saycode/executor-helper /build/executorHelper.c \
 && chown root:root /usr/local/lib/saycode/executor-helper \
 && chmod 0500 /usr/local/lib/saycode/executor-helper
COPY stage/toolRuntime.cjs /opt/toolRuntime.cjs
COPY docker/managed-launch/fdprobe.py /usr/local/lib/saycode/fdprobe.py
RUN chmod 0555 /usr/local/lib/saycode/fdprobe.py
COPY docker/managed-launch/verify-p4-isolation.sh /verify-p4-isolation.sh
RUN chmod +x /verify-p4-isolation.sh
