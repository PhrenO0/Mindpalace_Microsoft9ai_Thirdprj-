#!/bin/bash

# 1. 시스템 pip 설치
apt-get update && apt-get install -y python3-pip

# 2. backend 폴더 내부의 의존성 설치 (루트에 requirements.txt가 있다면 그대로 두고, backend 안에 있다면 경로 수정)
python3 -m pip install -r requirements.txt

# 3. uvicorn 실행 시 python path에 backend 폴더를 추가하여 실행
PYTHONPATH=./backend python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8080
