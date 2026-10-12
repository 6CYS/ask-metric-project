"""指标别名独立补录入口；事务与校验复用公共实现。"""
import sys

from sync_catalog_aliases import main

if __name__ == "__main__":
    raise SystemExit(main(["metrics", *sys.argv[1:]]))
