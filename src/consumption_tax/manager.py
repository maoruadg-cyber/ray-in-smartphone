"""
消費税管理マネージャー

取引の記録・集計・レポート出力を行う。
"""

import csv
import io
from datetime import date
from decimal import Decimal
from typing import Optional, Sequence

from .calculator import ConsumptionTaxCalculator, TaxReturnSummary
from .models import (
    PurchaseUsage,
    TaxCategory,
    Transaction,
    TransactionType,
)


class ConsumptionTaxManager:
    def __init__(self) -> None:
        self._transactions: list[Transaction] = []
        self._calculator = ConsumptionTaxCalculator()

    # ------------------------------------------------------------------ #
    # 取引の登録                                                           #
    # ------------------------------------------------------------------ #

    def add_domestic_sale(
        self,
        transaction_date: date,
        description: str,
        amount_excl_tax: Decimal,
        partner_name: str = "",
        invoice_number: str = "",
        reduced_rate: bool = False,
    ) -> Transaction:
        """国内課税売上を登録する。"""
        tx = Transaction(
            transaction_date=transaction_date,
            description=description,
            amount_excl_tax=amount_excl_tax,
            tax_category=TaxCategory.REDUCED_RATE if reduced_rate else TaxCategory.STANDARD_RATE,
            transaction_type=TransactionType.SALES,
            partner_name=partner_name,
            invoice_number=invoice_number,
        )
        self._transactions.append(tx)
        return tx

    def add_export_sale(
        self,
        transaction_date: date,
        description: str,
        amount: Decimal,
        partner_name: str = "",
    ) -> Transaction:
        """輸出免税売上を登録する（消費税は0%だが課税売上に算入）。"""
        tx = Transaction(
            transaction_date=transaction_date,
            description=description,
            amount_excl_tax=amount,
            tax_category=TaxCategory.EXPORT_EXEMPT,
            transaction_type=TransactionType.SALES,
            partner_name=partner_name,
        )
        self._transactions.append(tx)
        return tx

    def add_purchase(
        self,
        transaction_date: date,
        description: str,
        amount_excl_tax: Decimal,
        partner_name: str = "",
        invoice_number: str = "",
        reduced_rate: bool = False,
        purchase_usage: PurchaseUsage = PurchaseUsage.COMMON,
        non_taxable: bool = False,
    ) -> Transaction:
        """仕入・経費を登録する。"""
        if non_taxable:
            category = TaxCategory.NON_TAXABLE
        elif reduced_rate:
            category = TaxCategory.REDUCED_RATE
        else:
            category = TaxCategory.STANDARD_RATE

        tx = Transaction(
            transaction_date=transaction_date,
            description=description,
            amount_excl_tax=amount_excl_tax,
            tax_category=category,
            transaction_type=TransactionType.PURCHASE,
            partner_name=partner_name,
            invoice_number=invoice_number,
            purchase_usage=purchase_usage,
        )
        self._transactions.append(tx)
        return tx

    def add_transaction(self, transaction: Transaction) -> None:
        """任意の Transaction オブジェクトを直接追加する。"""
        self._transactions.append(transaction)

    # ------------------------------------------------------------------ #
    # 取引の参照                                                           #
    # ------------------------------------------------------------------ #

    def get_transactions(
        self,
        start: Optional[date] = None,
        end: Optional[date] = None,
        transaction_type: Optional[TransactionType] = None,
    ) -> list[Transaction]:
        result = self._transactions
        if start:
            result = [t for t in result if t.transaction_date >= start]
        if end:
            result = [t for t in result if t.transaction_date <= end]
        if transaction_type:
            result = [t for t in result if t.transaction_type == transaction_type]
        return sorted(result, key=lambda t: t.transaction_date)

    # ------------------------------------------------------------------ #
    # 申告計算                                                             #
    # ------------------------------------------------------------------ #

    def calculate_tax_return(
        self,
        start: Optional[date] = None,
        end: Optional[date] = None,
        use_individual_method: bool = True,
    ) -> TaxReturnSummary:
        """指定期間の消費税申告額を計算する。"""
        txs = self.get_transactions(start=start, end=end)
        return self._calculator.calculate(txs, use_individual_method=use_individual_method)

    # ------------------------------------------------------------------ #
    # レポート出力                                                         #
    # ------------------------------------------------------------------ #

    def print_tax_return_report(
        self,
        start: Optional[date] = None,
        end: Optional[date] = None,
        use_individual_method: bool = True,
    ) -> str:
        """申告書サマリーを文字列で返す。"""
        result = self.calculate_tax_return(start, end, use_individual_method)
        s = result.sales

        period = ""
        if start and end:
            period = f"{start} 〜 {end}"
        elif start:
            period = f"{start} 〜"
        elif end:
            period = f"〜 {end}"

        lines = [
            "=" * 60,
            "  消費税申告書サマリー",
            f"  対象期間: {period}" if period else "",
            "=" * 60,
            "",
            "【売上の内訳】",
            f"  課税売上（標準10%）    : {s.taxable_standard:>15,.0f} 円（税抜）",
            f"  課税売上（軽減 8%）    : {s.taxable_reduced:>15,.0f} 円（税抜）",
            f"  輸出免税売上            : {s.export_exempt:>15,.0f} 円",
            f"  非課税売上              : {s.non_taxable:>15,.0f} 円",
            f"  {'─'*45}",
            f"  課税売上合計（税抜）    : {s.taxable_sales_total:>15,.0f} 円",
            f"  売上合計                : {s.total_sales:>15,.0f} 円",
            "",
            f"  課税売上割合            : {result.taxable_sales_ratio:>14.1%}",
            f"  控除方式                : {result.credit_method}",
            "",
            "【税額計算】",
            f"  売上消費税額（国税）    : {result.output_tax:>15,.0f} 円",
            f"  仕入税額控除            : {result.input_tax_credit:>15,.0f} 円",
            f"  差引税額（国税）        : {result.net_tax_payable:>15,.0f} 円",
            f"  地方消費税              : {result.local_consumption_tax:>15,.0f} 円",
            f"  {'─'*45}",
            f"  合計納付税額            : {result.total_tax_payable:>15,.0f} 円",
            "=" * 60,
        ]
        return "\n".join(l for l in lines if l is not None)

    def export_transactions_csv(
        self,
        start: Optional[date] = None,
        end: Optional[date] = None,
    ) -> str:
        """取引一覧を CSV 文字列で返す。"""
        txs = self.get_transactions(start=start, end=end)
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow([
            "取引日", "種別", "相手先", "摘要", "課税区分",
            "税抜金額", "消費税額", "税込金額",
            "仕入用途区分", "適格請求書番号",
        ])
        for tx in txs:
            writer.writerow([
                tx.transaction_date,
                tx.transaction_type.value,
                tx.partner_name,
                tx.description,
                tx.tax_category.value,
                tx.amount_excl_tax,
                tx.tax_amount,
                tx.amount_incl_tax,
                tx.purchase_usage.value if tx.transaction_type == TransactionType.PURCHASE else "",
                tx.invoice_number,
            ])
        return buf.getvalue()
