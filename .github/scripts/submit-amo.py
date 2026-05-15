import jwt, time, requests, os, sys, glob, json

key    = os.environ['AMO_API_KEY']
secret = os.environ['AMO_API_SECRET']

payload = {'iss': key, 'jti': str(time.time()), 'iat': time.time(), 'exp': time.time() + 300}
token   = jwt.encode(payload, secret, algorithm='HS256')
headers = {'Authorization': f'JWT {token}'}

with open('dist/firefox/manifest.json') as f:
    version = json.load(f)['version']

xpis = glob.glob('dist/signed/*.xpi')
if not xpis:
    print('No XPI found, skipping AMO listed submission')
    sys.exit(0)

xpi_path = xpis[0]
url = f'https://addons.mozilla.org/api/v5/addons/canvas-messenger@hackatoa/versions/{version}/'
with open(xpi_path, 'rb') as f:
    r = requests.put(url, headers=headers, files={'upload': ('extension.xpi', f, 'application/x-xpinstall')})

if r.status_code in (200, 201, 202):
    print(f'AMO listed submission accepted: {r.status_code}')
else:
    print(f'AMO listed submission response: {r.status_code} {r.text}')
