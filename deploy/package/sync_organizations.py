"""机构预览：python sync_organizations.py；写入：追加 --apply。"""
from sync_catalog_data import run

if __name__ == "__main__":
    run("sync-org-catalog")
