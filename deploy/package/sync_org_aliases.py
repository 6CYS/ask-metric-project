"""机构别名独立补录入口；不执行机构主数据同步。"""
import sys

from sync_catalog_aliases import main

if __name__ == "__main__":
    raise SystemExit(main(["organizations", *sys.argv[1:]]))
