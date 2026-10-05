"""Explicit account metadata synchronization, no device control."""
import argparse
import sys

from .credential_store import CredentialStore
from .discovery import sync_account
from .mijia_backend import secure_api


def main():
    parser = argparse.ArgumentParser(description='同步全部账号设备和型号能力，不执行设备动作')
    parser.add_argument('--credential-dir', required=True)
    parser.add_argument('--confirm-account-read', action='store_true')
    args = parser.parse_args()
    if not args.confirm_account_read:
        parser.error('请明确添加 --confirm-account-read；该命令会读取小米云账号设备清单')
    api = None
    try:
        store = CredentialStore(args.credential_dir)
        with store.exclusive():
            api = secure_api(store)
            result = sync_account(api, store)
        ready = len(result['suggested_config']['devices'])
        print(f'已加密保存 {len(result["devices"])} 台设备；{ready} 台已有灯/插座映射，全部控制仍关闭。')
        return 0
    except Exception:
        print('同步未完成；旧清单和现有配置未改。请检查账号、网络和SDK版本。', file=sys.stderr)
        return 1
    finally:
        session = getattr(api, 'session', None)
        if session is not None:
            session.close()


if __name__ == '__main__':
    raise SystemExit(main())
