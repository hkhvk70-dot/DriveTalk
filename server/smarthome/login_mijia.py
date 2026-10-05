"""Manual, explicit account login only. Never invoked by the assistant."""
import argparse
import sys

from .credential_store import CredentialStore, validate_auth
from .mijia_backend import secure_api
from .discovery import sync_account


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--credential-dir', required=True)
    parser.add_argument('--confirm-account-login', action='store_true')
    parser.add_argument('--skip-discovery', action='store_true',
                        help='只保存登录，不同步账号设备清单及型号规格')
    args = parser.parse_args()
    if not args.confirm_account_login:
        parser.error('请明确添加 --confirm-account-login；该命令会连接小米账号服务')
    api = None
    try:
        store = CredentialStore(args.credential_dir)
        with store.exclusive():
            store.initialize()
            api = secure_api(store, login=True)
            print('请用米家 App 扫码；二维码/链接不要发送给模型或公共日志。')
            data = api.login()
            store.save(validate_auth(data))
            print('认证已加密保存；没有执行设备操作。')
            if not args.skip_discovery:
                try:
                    result = sync_account(api, store)
                    print(f'已自动发现并加密保存 {len(result["devices"])} 台设备；设备控制默认关闭。')
                except Exception:
                    print('登录成功，但设备同步未完成；可稍后单独执行 sync_mijia。', file=sys.stderr)
        return 0
    except Exception:
        print('登录未完成，请检查网络、账号验证或权限；未输出认证内容。', file=sys.stderr)
        return 1
    finally:
        session = getattr(api, 'session', None)
        if session is not None:
            session.close()


if __name__ == '__main__':
    raise SystemExit(main())
