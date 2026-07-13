uvicorn main:app --host 0.0.0.0 --port 8000 --workers 1

nohup venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000 --workers 1 > backend.log 2>&1 &

  =================================================================

  scp root@177.7.59.175:/root/Product_Management/backend/app.db C:\Users\dell\Downloads\

===================================================================

http://177.7.59.175:9000/docs

http://177.7.59.175:9000/openapi.json
